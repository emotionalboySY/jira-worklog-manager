// Jira 첨부/이미지 바이너리 프록시
// 기존 /api/proxy는 응답을 text()로 읽어 바이너리가 깨지므로 별도 엔드포인트로 분리.
import { applyCors, safeError } from './_cors.js'

export default async function handler(req, res) {
  applyCors(req, res, 'GET, OPTIONS')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const authHeader = req.headers.authorization
  if (!authHeader) return res.status(401).json({ error: 'Authorization header required' })

  const targetUrl = req.query.url
  if (!targetUrl || !targetUrl.startsWith('https://api.atlassian.com/')) {
    return res.status(400).json({ error: 'Invalid target URL' })
  }

  try {
    const apiRes = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/octet-stream, image/*, */*',
      },
      redirect: 'follow',
    })

    if (!apiRes.ok) {
      return res.status(apiRes.status).json({ error: `Upstream ${apiRes.status}` })
    }

    const contentType = apiRes.headers.get('content-type') || 'application/octet-stream'
    res.setHeader('Content-Type', contentType)
    // 캐시는 브라우저 쪽 메모리로만 (blob URL 재사용)
    res.setHeader('Cache-Control', 'private, max-age=300')

    const buffer = Buffer.from(await apiRes.arrayBuffer())
    return res.status(200).send(buffer)
  } catch (err) {
    return res.status(500).json(safeError(err, 'attachment'))
  }
}
