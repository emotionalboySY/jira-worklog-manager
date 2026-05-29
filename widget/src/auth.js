// 데스크톱 OAuth(3LO, loopback) + 토큰 저장/갱신.
// - 로그인: 로컬 루프백(43117) 서버를 Rust가 띄우고, 시스템 브라우저로 Atlassian authorize를 연다.
//   콜백(code)을 'oauth://callback' 이벤트로 받아 배포된 /api/auth/callback 으로 교환(시크릿은 서버 보유).
// - 토큰은 tauri-plugin-store(auth.json)에 영속. Jira/세션 API는 http 플러그인 fetch로 CORS 우회 호출.
import { invoke } from '@tauri-apps/api/core'
import { once } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import { fetch } from '@tauri-apps/plugin-http'
import { load } from '@tauri-apps/plugin-store'
import { CONFIG } from './config.js'

let _store = null
async function store() {
  if (!_store) _store = await load('auth.json', { autoSave: true })
  return _store
}

export async function getTokens() {
  const s = await store()
  return {
    accessToken: (await s.get('access_token')) || null,
    refreshToken: (await s.get('refresh_token')) || null,
    expiresAt: (await s.get('expires_at')) || 0,
  }
}

async function saveTokens(data) {
  const s = await store()
  await s.set('access_token', data.access_token)
  if (data.refresh_token) await s.set('refresh_token', data.refresh_token)
  await s.set('expires_at', Date.now() + (data.expires_in || 3600) * 1000)
  await s.save()
}

export async function isLoggedIn() {
  return !!(await getTokens()).accessToken
}

export async function logout() {
  const s = await store()
  await s.clear()
  await s.save()
}

// 로그인: 루프백 서버 기동 → 브라우저 authorize → code 수신 → 토큰 교환 → 저장.
export async function login() {
  if (!CONFIG.clientId) throw new Error('VITE_ATLASSIAN_CLIENT_ID 미설정 (widget/.env 확인)')
  const state = crypto.randomUUID()
  const port = await invoke('start_oauth_listener') // 43117

  // 콜백 대기 (3분 타임아웃)
  const callbackPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('로그인 시간 초과')), 180000)
    once('oauth-callback', (e) => {
      clearTimeout(timer)
      const params = new URLSearchParams(e.payload || '')
      resolve({ code: params.get('code'), state: params.get('state'), error: params.get('error') })
    }).catch(reject)
  })

  const authUrl = `https://auth.atlassian.com/authorize?` + new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: CONFIG.clientId,
    scope: CONFIG.scopes,
    redirect_uri: `http://localhost:${port}/callback`,
    state,
    response_type: 'code',
  })
  await openUrl(authUrl)

  const cb = await callbackPromise
  if (cb.error) throw new Error(`인증 거부: ${cb.error}`)
  if (!cb.code) throw new Error('인증 코드를 받지 못했습니다.')
  if (cb.state !== state) throw new Error('state 불일치(보안)')

  const res = await fetch(`${CONFIG.apiBase}/api/auth/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: cb.code, redirect_uri: `http://localhost:${port}/callback` }),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`토큰 교환 실패 ${res.status}: ${t.slice(0, 200)}`)
  }
  await saveTokens(await res.json())
  return true
}

// 동시 갱신 방지(일회성 refresh_token 정책 대응) — in-flight promise 캐시
let _refreshing = null
export async function refreshAccessToken() {
  if (_refreshing) return _refreshing
  _refreshing = (async () => {
    const { refreshToken } = await getTokens()
    if (!refreshToken) return false
    try {
      const res = await fetch(`${CONFIG.apiBase}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      })
      if (!res.ok) { await logout(); return false }
      await saveTokens(await res.json())
      return true
    } catch (e) {
      console.error('토큰 갱신 실패:', e)
      return false
    }
  })()
  try { return await _refreshing } finally { _refreshing = null }
}

// 유효한 access token 확보(만료 1분 전이면 선제 갱신). 실패 시 null.
export async function ensureAccessToken() {
  const { accessToken, expiresAt } = await getTokens()
  if (!accessToken) return null
  if (expiresAt && Date.now() > expiresAt - 60000) {
    const ok = await refreshAccessToken()
    if (!ok) return null
    return (await getTokens()).accessToken
  }
  return accessToken
}
