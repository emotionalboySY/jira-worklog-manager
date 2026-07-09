// 동적 웹훅 보장(등록/갱신) — 브라우저가 로그인 직후 + 주기적으로 Bearer 로 호출.
//
// 3LO 동적 웹훅은 30일 만료된다. 서버가 refresh token을 저장하지 않고, 사용자가 앱을
// 열 때 그 세션의 access token으로 등록/갱신한다(별도 크론·서버 토큰 저장 불필요).
// 사용자가 30일 이상 앱을 안 열면 웹훅이 만료되지만, 다음 접속 시 자동 재등록된다.
//
// Redis:
//   whookreg:{accountId} = { webhookId, token, expiresAt, jql }   (등록 상태)
//   whooktok:{token}     = accountId                              (수신 역매핑)
import { applyCors, safeError } from './_cors.js'
import { getRedis, resolveAccountId } from './_identity.js'
import { randomBytes } from 'node:crypto'

// 감지 대상: 담당자/보고자/워쳐 이슈의 생성·수정·삭제.
// (워크로그/코멘트 변경도 대개 issue_updated로 반영되고, 실제 재로드가 전량 재조회하므로
//  이슈 이벤트만으로 "변경 신호"는 충분하다.)
const EVENTS = ['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted']
const JQL = 'assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()'

const LIFETIME_MS = 30 * 24 * 60 * 60 * 1000     // 동적 웹훅 수명 30일
const REFRESH_BEFORE_MS = 5 * 24 * 60 * 60 * 1000 // 만료 5일 이내면 미리 갱신

// 콜백 베이스 URL. 프리뷰 배포가 엉뚱한 URL을 등록하지 않도록 WEBHOOK_BASE_URL 우선,
// 없으면 요청 헤더에서 추출(프로덕션 접속 시 프로덕션 도메인이 잡힘).
function baseUrl(req) {
  const env = process.env.WEBHOOK_BASE_URL
  if (env) return env.replace(/\/+$/, '')
  const proto = req.headers['x-forwarded-proto'] || 'https'
  const host = req.headers['x-forwarded-host'] || req.headers.host
  return `${proto}://${host}`
}

// Jira Cloud REST v3 프록시 호출.
async function jira(cloudId, token, path, method, body) {
  const r = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const data = await r.json().catch(() => null)
  return { ok: r.ok, status: r.status, data }
}

export default async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' })
  res.setHeader('Cache-Control', 'no-store')

  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  // [진단] 401 원인 구분용 로그 — 헤더 유무/토큰 길이. 원인 확인 후 제거 예정.
  console.error('[webhook-ensure] 진입 hasAuthHeader=%s authLen=%d tokenLen=%d hasBody=%s',
    !!req.headers.authorization, auth.length, token.length, !!req.body)
  if (!token) {
    console.error('[webhook-ensure] 401 no-token (Authorization 헤더 없음/형식 불일치)')
    return res.status(401).json({ error: 'unauthorized' })
  }

  // 클라가 조작 중인 cloudId를 그대로 사용(앱이 보는 사이트와 일치). 없으면 서버가 해석.
  let cloudId = (req.body && typeof req.body.cloudId === 'string') ? req.body.cloudId : ''

  let accountId
  try {
    accountId = await resolveAccountId(token)
  } catch (e) {
    return res.status(500).json(safeError(e, 'webhook-ensure/identity'))
  }
  if (!accountId) {
    console.error('[webhook-ensure] 401 no-accountId (resolveAccountId가 null 반환)')
    return res.status(401).json({ error: 'unauthorized' })
  }

  const redis = getRedis()

  try {
    if (!cloudId) {
      const r = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      })
      const list = await r.json().catch(() => null)
      cloudId = Array.isArray(list) && list[0]?.id
    }
    if (!cloudId) return res.status(400).json({ error: 'cloudId 없음' })

    const regKey = `whookreg:${accountId}`
    const reg = await redis.get(regKey) // 객체 또는 null (@upstash 자동 역직렬화)
    const now = Date.now()

    // 유효한 등록이 이미 있고 만료 여유도 충분 → 아무것도 안 함(가장 흔한 경로).
    const stillValid = reg && typeof reg === 'object'
      && Number.isFinite(reg.webhookId)
      && Number.isFinite(reg.expiresAt)
      && reg.jql === JQL
      && (reg.expiresAt - now) > REFRESH_BEFORE_MS
    if (stillValid) {
      return res.status(200).json({ ok: true, action: 'none', expiresAt: reg.expiresAt })
    }

    // 불투명 토큰: 있으면 재사용(콜백 URL 안정), 없으면 신규 생성.
    const whToken = (reg && typeof reg.token === 'string' && reg.token)
      || randomBytes(24).toString('hex')
    const callbackUrl = `${baseUrl(req)}/api/webhook?k=${whToken}`

    // 기존 webhookId가 살아있고 JQL도 동일하면 refresh로 수명만 연장 시도.
    if (reg && Number.isFinite(reg.webhookId) && reg.jql === JQL) {
      const refreshed = await jira(cloudId, token, '/webhook/refresh', 'PUT', {
        webhookIds: [reg.webhookId],
      })
      if (refreshed.ok) {
        const exp = Date.parse(refreshed.data?.expirationDate) || (now + LIFETIME_MS)
        const next = { webhookId: reg.webhookId, token: whToken, expiresAt: exp, jql: JQL }
        await redis.set(regKey, next)
        await redis.set(`whooktok:${whToken}`, accountId)
        return res.status(200).json({ ok: true, action: 'refresh', expiresAt: exp })
      }
      // refresh 실패(만료 소멸 등) → 아래 재등록으로 폴백.
    }

    // 재등록 전, 기존 웹훅이 있으면 중복 방지 위해 삭제 시도(실패 무시).
    if (reg && Number.isFinite(reg.webhookId)) {
      try {
        await jira(cloudId, token, '/webhook', 'DELETE', { webhookIds: [reg.webhookId] })
      } catch {}
    }

    // 신규 등록(첫 등록 / JQL 변경 / refresh 실패 후 재등록).
    const created = await jira(cloudId, token, '/webhook', 'POST', {
      url: callbackUrl,
      webhooks: [{ events: EVENTS, jqlFilter: JQL }],
    })
    if (!created.ok) {
      return res.status(created.status || 502).json({ error: 'webhook 등록 실패', detail: created.data })
    }
    const result = created.data?.webhookRegistrationResult?.[0]
    const webhookId = Number(result?.createdWebhookId)
    if (!Number.isFinite(webhookId)) {
      // JQL/이벤트 거부 등은 여기서 errors 배열로 반환됨 → 디버그용으로 그대로 노출.
      return res.status(502).json({ error: 'webhookId 없음', detail: created.data })
    }
    const exp = now + LIFETIME_MS
    const next = { webhookId, token: whToken, expiresAt: exp, jql: JQL }
    await redis.set(regKey, next)
    await redis.set(`whooktok:${whToken}`, accountId)
    return res.status(200).json({ ok: true, action: 'register', expiresAt: exp })
  } catch (e) {
    return res.status(500).json(safeError(e, 'webhook-ensure'))
  }
}
