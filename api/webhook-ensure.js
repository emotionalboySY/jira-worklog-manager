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
import { getRedis } from './_identity.js'
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

// accountId + cloudId를 한 번에 해석하고, 실패 시 사유(HTTP 상태)를 명시적으로 남긴다.
// 공유 resolveAccountId는 실패를 null로 뭉뚱그려 원인 파악이 어렵고 캐시 상태에 의존하므로,
// webhook-ensure는 자체 해석(캐시 우회) + 상태코드 로깅을 쓴다.
// 반환: { accountId, cloudId } | { error, retriable }
async function resolveIdentity(token) {
  // 내부에서 로깅하지 않고 사유를 구조체로 반환한다(호출부가 한 줄로 통합 로깅 → 로그
  // 뷰어가 요청당 첫 줄만 보여주는 제약 우회). 반환: { accountId, cloudId } | { error, status, detail, retriable }
  let rr
  try {
    rr = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
  } catch (e) {
    return { error: 'accessible-resources:network', detail: e?.message, retriable: true }
  }
  if (!rr.ok) {
    const body = await rr.text().catch(() => '')
    return { error: 'accessible-resources', status: rr.status, detail: body.slice(0, 200), retriable: rr.status === 429 || rr.status >= 500 }
  }
  const list = await rr.json().catch(() => null)
  const cloudId = Array.isArray(list) && list[0]?.id
  if (!cloudId) return { error: 'no-accessible-site', status: Array.isArray(list) ? list.length : -1 }
  let mr
  try {
    mr = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
  } catch (e) {
    return { error: 'myself:network', detail: e?.message, retriable: true }
  }
  if (!mr.ok) {
    const body = await mr.text().catch(() => '')
    return { error: 'myself', status: mr.status, detail: body.slice(0, 200), retriable: mr.status === 429 || mr.status >= 500 }
  }
  const me = await mr.json().catch(() => null)
  const accountId = me?.accountId
  if (!accountId) return { error: 'no-accountId' }
  return { accountId, cloudId }
}

export default async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' })
  res.setHeader('Cache-Control', 'no-store')

  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) {
    console.error('[webhook-ensure] 실패 원인=no-token hasAuthHeader=%s authLen=%d', !!req.headers.authorization, auth.length)
    return res.status(401).json({ error: 'unauthorized', reason: 'no-token' })
  }

  // 신원 해석(accountId + cloudId). 로드 직후 레이스/레이트리밋으로 일시 실패할 수 있어
  // 재시도 가능한 오류(429/5xx/네트워크)는 짧게 백오프 후 재시도한다.
  let ident = null
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      ident = await resolveIdentity(token)
      if (ident.accountId || !ident.retriable) break
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)))
    }
  } catch (e) {
    return res.status(500).json(safeError(e, 'webhook-ensure/identity'))
  }
  if (!ident || !ident.accountId) {
    // 통합 진단 로그(요청당 첫 줄) — 사유·HTTP상태·Atlassian 응답 본문 일부·토큰 길이.
    console.error('[webhook-ensure] 실패 원인=%s status=%s detail=%s tokenLen=%d',
      ident?.error, ident?.status, ident?.detail, token.length)
    return res.status(401).json({ error: 'identity 해석 실패', reason: ident?.error, status: ident?.status, detail: ident?.detail })
  }
  const accountId = ident.accountId
  const cloudId = ident.cloudId

  const redis = getRedis()

  try {
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
      // Jira가 등록을 거부(대개 scope 부족이면 401/403 + 메시지). 상태·본문을 첫 줄에 로깅.
      console.error('[webhook-ensure] 등록 거부 status=%s detail=%s', created.status, JSON.stringify(created.data).slice(0, 300))
      return res.status(created.status || 502).json({ error: 'webhook 등록 실패', jiraStatus: created.status, detail: created.data })
    }
    const result = created.data?.webhookRegistrationResult?.[0]
    const webhookId = Number(result?.createdWebhookId)
    if (!Number.isFinite(webhookId)) {
      // JQL/이벤트 거부 등은 여기서 errors 배열로 반환됨 → 디버그용으로 그대로 노출.
      console.error('[webhook-ensure] webhookId 없음 detail=%s', JSON.stringify(created.data).slice(0, 300))
      return res.status(502).json({ error: 'webhookId 없음', detail: created.data })
    }
    const exp = now + LIFETIME_MS
    const next = { webhookId, token: whToken, expiresAt: exp, jql: JQL }
    await redis.set(regKey, next)
    await redis.set(`whooktok:${whToken}`, accountId)
    console.error('[webhook-ensure] 등록 성공 webhookId=%s', webhookId)
    return res.status(200).json({ ok: true, action: 'register', expiresAt: exp })
  } catch (e) {
    return res.status(500).json(safeError(e, 'webhook-ensure'))
  }
}
