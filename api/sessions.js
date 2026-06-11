// 세션 동기 API — 웹앱/위젯이 공유하는 작업 세션의 단일 소스.
//
// GET  /api/sessions            → { sessions, rev }
// POST /api/sessions            → { action, payload } 변이 적용 후 { sessions, rev }
//   action: start|pause|resume|remove|deleteSegment|swap|adjustStart|replaceAll
//
// 인증: Authorization: Bearer <Atlassian access token>  → account_id 로 버킷 식별.
// 저장: Redis key `sessions:{accountId}` 에 { sessions, rev } JSON.
// 동시성: 서버가 "읽기→변이→rev 비교 후 저장(CAS)"을 Lua로 원자 처리하고,
//         충돌 시 최신 상태로 재시도(변이는 의도 기반이라 최신 상태에 재적용해도 안전).
//         단 replaceAll(마이그레이션 시드)은 재시도하지 않고 충돌 시 409 → 클라가 서버 상태 채택.
import { applyCors, safeError } from './_cors.js'
import { getRedis, resolveAccountId } from './_identity.js'
import { applyAction } from '../lib/sessionLogic.js'

// rev 비교 후 저장. 일치하면 새 값 저장 후 'OK', 불일치면 'CONFLICT:<현재 JSON>' 반환.
// 단일 문자열 반환이라 @upstash 자동 역직렬화에 휘둘리지 않는다.
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
local curRev = 0
if cur then
  local ok, d = pcall(cjson.decode, cur)
  if ok and type(d) == 'table' and d.rev then curRev = d.rev end
end
if tonumber(ARGV[1]) ~= curRev then
  return 'CONFLICT:' .. (cur or '')
end
redis.call('SET', KEYS[1], ARGV[2])
return 'OK'
`

async function readState(redis, key) {
  const raw = await redis.get(key) // 자동 역직렬화 → 객체 또는 null
  if (raw && typeof raw === 'object' && Array.isArray(raw.sessions)) {
    return { sessions: raw.sessions, rev: typeof raw.rev === 'number' ? raw.rev : 0 }
  }
  return { sessions: [], rev: 0 }
}

// baseRev 기준 CAS 저장. { ok, state } 반환.
async function casWrite(redis, key, baseRev, sessions) {
  const newState = { sessions, rev: baseRev + 1 }
  const ret = await redis.eval(CAS_SCRIPT, [key], [String(baseRev), JSON.stringify(newState)])
  if (ret === 'OK') return { ok: true, state: newState }
  const curJson = typeof ret === 'string' && ret.startsWith('CONFLICT:')
    ? ret.slice('CONFLICT:'.length)
    : ''
  let cur = null
  try { cur = curJson ? JSON.parse(curJson) : null } catch {}
  const state = cur && Array.isArray(cur.sessions)
    ? { sessions: cur.sessions, rev: typeof cur.rev === 'number' ? cur.rev : 0 }
    : { sessions: [], rev: 0 }
  return { ok: false, state }
}

export default async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  // 사용자 세션 데이터 — 캐시 차단
  res.setHeader('Cache-Control', 'no-store')

  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return res.status(401).json({ error: 'unauthorized' })

  let accountId
  try {
    accountId = await resolveAccountId(token)
  } catch (e) {
    return res.status(500).json(safeError(e, 'sessions/identity'))
  }
  if (!accountId) return res.status(401).json({ error: 'unauthorized' })

  const redis = getRedis()
  const key = `sessions:${accountId}`

  try {
    if (req.method === 'GET') {
      return res.status(200).json(await readState(redis, key))
    }

    if (req.method === 'POST') {
      const { action, payload } = req.body || {}
      if (!action) return res.status(400).json({ error: 'action required' })

      // 시각 의존 변이(start/pause/resume)는 클라가 보낸 nowMs로 적용해
      // 낙관적 결과와 권위 결과의 타임스탬프를 일치시킨다(서버/클라 시계 차 방지).
      // Number.isFinite — JSON의 1e999(→Infinity) 등이 iso() RangeError 500을 내지 않도록
      const nowMs = (payload && Number.isFinite(payload.nowMs)) ? payload.nowMs : Date.now()
      const maxAttempts = action === 'replaceAll' ? 1 : 4
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const current = await readState(redis, key)
        const result = applyAction(action, current.sessions, payload || {}, nowMs)
        if (result.ok === false) {
          return res.status(400).json({ error: result.error || 'invalid action', sessions: current.sessions, rev: current.rev })
        }
        const written = await casWrite(redis, key, current.rev, result.sessions)
        if (written.ok) {
          return res.status(200).json({ sessions: written.state.sessions, rev: written.state.rev })
        }
        // 충돌 → 최신 상태로 재시도 (replaceAll은 maxAttempts=1이라 루프 종료)
      }
      // 재시도 소진(드묾) → 최신 상태 반환, 클라가 재조정
      const latest = await readState(redis, key)
      return res.status(409).json({ sessions: latest.sessions, rev: latest.rev })
    }

    return res.status(405).json({ error: 'method not allowed' })
  } catch (e) {
    return res.status(500).json(safeError(e, 'sessions'))
  }
}
