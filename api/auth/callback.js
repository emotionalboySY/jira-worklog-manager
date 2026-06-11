// OAuth 토큰 교환: authorization code → access token
import { applyCors, safeError } from '../_cors.js'

export default async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // 토큰이 담기는 응답 — 브라우저/중간 캐시 차단
  res.setHeader('Cache-Control', 'no-store')

  // 본문 없는 POST/비JSON 요청에서 TypeError로 500이 나지 않도록 방어
  const { code, redirect_uri } = req.body || {}
  if (!code) return res.status(400).json({ error: 'code is required' })

  // 서버 전용 별칭(ATLASSIAN_CLIENT_ID)이 있으면 우선 사용, 없으면 VITE_* fallback
  const clientId = process.env.ATLASSIAN_CLIENT_ID || process.env.VITE_ATLASSIAN_CLIENT_ID

  try {
    const tokenRes = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: process.env.ATLASSIAN_CLIENT_SECRET,
        code,
        redirect_uri,
      }),
    })

    const data = await tokenRes.json()

    if (!tokenRes.ok) {
      // Atlassian의 에러 메시지는 안전하게 그대로 통과 (사용자 디버그용)
      return res.status(tokenRes.status).json(data)
    }

    return res.status(200).json(data)
  } catch (err) {
    return res.status(500).json(safeError(err, 'auth/callback'))
  }
}
