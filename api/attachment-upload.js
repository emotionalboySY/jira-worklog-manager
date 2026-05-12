// Jira 이슈 첨부 업로드 프록시
// 클라이언트에서 multipart/form-data로 보낸 본문을 그대로 Jira로 전달.
// Jira의 /issue/{key}/attachments는 X-Atlassian-Token: no-check가 필수.
import { applyCors, safeError } from './_cors.js'

export const config = {
  api: { bodyParser: false },
}

export default async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const authHeader = req.headers.authorization
  if (!authHeader) return res.status(401).json({ error: 'Authorization header required' })

  const cloudId = String(req.query.cloudId || '')
  const issueKey = String(req.query.issueKey || '')
  const contentType = req.headers['content-type'] || ''

  // 입력 검증: 클라우드 ID/이슈 키 형식, 멀티파트 여부
  if (!/^[a-f0-9-]{8,}$/i.test(cloudId)) return res.status(400).json({ error: 'Invalid cloudId' })
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) return res.status(400).json({ error: 'Invalid issueKey' })
  if (!contentType.startsWith('multipart/form-data')) {
    return res.status(400).json({ error: 'multipart/form-data required' })
  }

  try {
    // 원시 본문 수집 (boundary 포함된 multipart 그대로)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)

    const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`
    const apiRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': contentType,
        'X-Atlassian-Token': 'no-check',
        'Accept': 'application/json',
      },
      body,
    })

    const text = await apiRes.text()
    const ctype = apiRes.headers.get('content-type')
    if (ctype) res.setHeader('Content-Type', ctype)
    return res.status(apiRes.status).send(text)
  } catch (err) {
    return res.status(500).json(safeError(err, 'attachment-upload'))
  }
}
