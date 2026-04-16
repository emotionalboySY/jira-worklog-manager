// Jira API 프록시: CORS 우회
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()

  const authHeader = req.headers.authorization
  if (!authHeader) return res.status(401).json({ error: 'Authorization header required' })

  // 요청 경로에서 Jira API URL 추출
  // /api/proxy?url=https://api.atlassian.com/...
  const targetUrl = req.query.url
  if (!targetUrl || !targetUrl.startsWith('https://api.atlassian.com/')) {
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
    const data = await apiRes.json().catch(() => null)

    return res.status(apiRes.status).json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
