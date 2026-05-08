// 토큰 갱신: refresh token → new access token
import { applyCors, safeError } from '../_cors.js'

export default async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { refresh_token } = req.body
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token is required' })

  const clientId = process.env.ATLASSIAN_CLIENT_ID || process.env.VITE_ATLASSIAN_CLIENT_ID

  try {
    const tokenRes = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: process.env.ATLASSIAN_CLIENT_SECRET,
        refresh_token,
      }),
    })

    const data = await tokenRes.json()

    if (!tokenRes.ok) {
      return res.status(tokenRes.status).json(data)
    }

    return res.status(200).json(data)
  } catch (err) {
    return res.status(500).json(safeError(err, 'auth/refresh'))
  }
}
