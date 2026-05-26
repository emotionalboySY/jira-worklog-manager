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

    // 업로드 성공 시 각 첨부의 Media Services UUID를 추가로 조회해 응답에 주입한다.
    // ADF media.attrs.id에는 numeric attachment id가 아니라 이 UUID가 들어가야 하며,
    // 그렇지 않으면 description PUT 시 ATTACHMENT_VALIDATION_ERROR가 발생한다.
    // UUID는 /rest/api/3/attachment/content/{id}의 302 Location에서 추출한다.
    if (apiRes.ok) {
      try {
        const arr = JSON.parse(text)
        if (Array.isArray(arr)) {
          await Promise.all(arr.map(async (a) => {
            if (!a || a.id == null) return
            try {
              const mid = await resolveMediaId(cloudId, String(a.id), authHeader)
              if (mid) a.mediaId = mid
            } catch (e) {
              // 실패해도 업로드 자체는 성공이므로 mediaId 없이 진행
              console.warn('[attachment-upload] mediaId 조회 실패:', a.id, e?.message || e)
            }
          }))
          res.setHeader('Content-Type', 'application/json')
          return res.status(apiRes.status).send(JSON.stringify(arr))
        }
      } catch {
        // JSON 파싱 실패면 원문 그대로 전달
      }
    }

    const ctype = apiRes.headers.get('content-type')
    if (ctype) res.setHeader('Content-Type', ctype)
    return res.status(apiRes.status).send(text)
  } catch (err) {
    return res.status(500).json(safeError(err, 'attachment-upload'))
  }
}

// /rest/api/3/attachment/content/{id}는 api.media.atlassian.com으로 302 리다이렉트되며
// Location의 경로(/file/<UUID>/binary)에서 Media Services 파일 UUID를 추출할 수 있다.
async function resolveMediaId(cloudId, attachmentId, authHeader) {
  const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
  })
  // Node fetch는 manual 리다이렉트 시 상태코드를 그대로 노출 (보통 302/303/307)
  const location = res.headers.get('location')
  if (!location) return null
  // 예: https://api.media.atlassian.com/file/<UUID>/binary?token=...
  const m = location.match(/\/file\/([0-9a-f-]{8,})/i)
  return m ? m[1] : null
}
