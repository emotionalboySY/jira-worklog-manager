// Jira API 프록시: CORS 우회
import { applyCors, safeError } from './_cors.js'

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
