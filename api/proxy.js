// Jira API 프록시: CORS 우회
// 부수 효과: 웹앱이 이슈를 편집(POST/PUT/DELETE)하면 그 이슈를 잠깐 selfedit에 등록한다.
// 웹훅 수신부(api/webhook.js)가 이를 보고 "본인이 웹앱에서 한 편집"을 알림에서 제외한다.
// (위젯은 프록시를 안 거치지만 워크로그 전용 변경이라 웹훅 쪽 휴리스틱이 걸러낸다.)
import { applyCors, safeError } from './_cors.js'
import { getRedis, resolveAccountId } from './_identity.js'

const SELF_EDIT_TTL_S = 120 // selfedit 표식 수명 — 웹훅은 편집 직후 수초 내 도착

// Jira 이슈 변경 요청이면 이슈 키를 반환(예: .../rest/api/3/issue/DKT-123/...). 아니면 null.
function issueKeyFromUrl(targetUrl) {
  const m = targetUrl.match(/\/rest\/api\/3\/issue\/([^/?#]+)/)
  if (!m) return null
  const key = decodeURIComponent(m[1])
  return /^[A-Z][A-Z0-9]+-\d+$/.test(key) ? key : null // 숫자 id·bulk 등은 제외
}

// 성공한 이슈 변경을 selfedit에 등록(실패는 무시 — 알림 억제는 best-effort).
async function registerSelfEdit(authHeader, targetUrl) {
  try {
    const issueKey = issueKeyFromUrl(targetUrl)
    if (!issueKey) return
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    const accountId = await resolveAccountId(token) // 폴링으로 대개 캐시 히트(Redis)
    if (!accountId) return
    await getRedis().set(`selfedit:${accountId}:${issueKey}`, Date.now(), { ex: SELF_EDIT_TTL_S })
  } catch { /* 무시 */ }
}

export default async function handler(req, res) {
  applyCors(req, res, 'GET, POST, PUT, DELETE, OPTIONS')

  if (req.method === 'OPTIONS') return res.status(200).end()

  const authHeader = req.headers.authorization
  if (!authHeader) return res.status(401).json({ error: 'Authorization header required' })

  // 사용자 데이터가 담기는 응답 — 캐시 차단
  res.setHeader('Cache-Control', 'no-store')

  // 요청 경로에서 Jira API URL 추출
  // /api/proxy?url=https://api.atlassian.com/...
  // (?url=a&url=b 처럼 중복 전달 시 배열이 되므로 string 타입까지 검사)
  const targetUrl = req.query.url
  if (typeof targetUrl !== 'string' || !targetUrl.startsWith('https://api.atlassian.com/')) {
    return res.status(400).json({ error: 'Invalid target URL' })
  }

  try {
    const options = {
      method: req.method,
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    }

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      options.body = JSON.stringify(req.body)
    }

    const apiRes = await fetch(targetUrl, options)

    // 성공한 이슈 편집이면 selfedit 등록(웹훅이 본인 웹앱 편집을 알림에서 제외하도록).
    if (apiRes.ok && (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE')) {
      await registerSelfEdit(authHeader, targetUrl)
    }

    // 원본 응답을 그대로 전달 (에러 본문 유실 방지)
    const body = await apiRes.text()
    const contentType = apiRes.headers.get('content-type')
    if (contentType) res.setHeader('Content-Type', contentType)
    // Atlassian의 rate limit 헤더는 클라이언트가 백오프 판단 시 필요
    const retryAfter = apiRes.headers.get('retry-after')
    if (retryAfter) res.setHeader('Retry-After', retryAfter)
    return res.status(apiRes.status).send(body)
  } catch (err) {
    return res.status(500).json(safeError(err, 'proxy'))
  }
}
