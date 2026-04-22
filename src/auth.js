// ========== Atlassian OAuth 2.0 (3LO) ==========
const CLIENT_ID = import.meta.env.VITE_ATLASSIAN_CLIENT_ID
const SCOPES = 'read:jira-work write:jira-work read:jira-user offline_access'

function getRedirectUri() {
  return window.location.origin + '/'
}

// 인증 URL 생성 후 리다이렉트
export function login() {
  const state = crypto.randomUUID()
  sessionStorage.setItem('oauth_state', state)

  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: getRedirectUri(),
    state,
    response_type: 'code',
    prompt: 'consent',
  })

  window.location.href = `https://auth.atlassian.com/authorize?${params}`
}

// URL에서 authorization code 감지 및 토큰 교환
export async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  const state = params.get('state')

  if (!code) return false

  // state 검증
  const savedState = sessionStorage.getItem('oauth_state')
  if (state !== savedState) {
    console.error('OAuth state 불일치')
    cleanUrl()
    return false
  }
  sessionStorage.removeItem('oauth_state')

  try {
    const res = await fetch('/api/auth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        redirect_uri: getRedirectUri(),
      }),
    })

    const data = await res.json()

    if (!res.ok) {
      console.error('토큰 교환 실패:', data)
      cleanUrl()
      return false
    }

    // 토큰 저장
    saveTokens(data)
    cleanUrl()

    // Cloud ID 가져오기
    await fetchAndSaveCloudId()

    return true
  } catch (err) {
    console.error('OAuth 콜백 처리 실패:', err)
    cleanUrl()
    return false
  }
}

// 토큰 갱신
export async function refreshAccessToken() {
  const refreshToken = localStorage.getItem('jira_refresh_token')
  if (!refreshToken) return false

  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })

    const data = await res.json()

    if (!res.ok) {
      console.error('토큰 갱신 실패:', data)
      logout()
      return false
    }

    saveTokens(data)
    return true
  } catch (err) {
    console.error('토큰 갱신 실패:', err)
    logout()
    return false
  }
}

// Jira API 호출 (프록시 경유)
// 성공: JSON 응답 반환 (204 No Content나 JSON이 아닌 경우 null)
// 실패: HTTP 상태 에러는 throw하여 호출부 try/catch가 감지 가능하도록 함
export async function jiraFetch(path, options = {}) {
  const accessToken = localStorage.getItem('jira_access_token')
  const cloudId = localStorage.getItem('jira_cloud_id')

  if (!accessToken || !cloudId) return null

  const baseUrl = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`
  const targetUrl = `${baseUrl}${path}`

  const doFetch = (token) => fetch(`/api/proxy?url=${encodeURIComponent(targetUrl)}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })

  let res = await doFetch(accessToken)

  // 401이면 토큰 갱신 후 재시도
  if (res.status === 401) {
    const refreshed = await refreshAccessToken()
    if (!refreshed) return null
    const newToken = localStorage.getItem('jira_access_token')
    res = await doFetch(newToken)
  }

  if (!res.ok) {
    let detail = ''
    try { detail = await res.text() } catch {}
    const err = new Error(`Jira API ${res.status} ${res.statusText || ''}: ${detail.slice(0, 400)}`.trim())
    err.status = res.status
    err.detail = detail
    throw err
  }

  if (res.status === 204) return null
  const ctype = res.headers.get('content-type') || ''
  if (!ctype.includes('application/json')) return null
  return res.json()
}

// 접근 가능한 리소스에서 Cloud ID 가져오기
async function fetchAndSaveCloudId() {
  const accessToken = localStorage.getItem('jira_access_token')
  if (!accessToken) return

  const res = await fetch(`/api/proxy?url=${encodeURIComponent('https://api.atlassian.com/oauth/token/accessible-resources')}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  })

  const resources = await res.json()

  if (Array.isArray(resources) && resources.length > 0) {
    localStorage.setItem('jira_cloud_id', resources[0].id)
    localStorage.setItem('jira_site_name', resources[0].name)
  }
}

// 현재 사용자 정보 가져오기
export async function fetchCurrentUser() {
  return jiraFetch('/myself')
}

// 토큰 저장
function saveTokens(data) {
  localStorage.setItem('jira_access_token', data.access_token)
  if (data.refresh_token) {
    localStorage.setItem('jira_refresh_token', data.refresh_token)
  }
  const expiresAt = Date.now() + (data.expires_in * 1000)
  localStorage.setItem('jira_token_expires_at', expiresAt.toString())
}

// URL에서 OAuth 파라미터 제거
function cleanUrl() {
  const url = new URL(window.location)
  url.searchParams.delete('code')
  url.searchParams.delete('state')
  window.history.replaceState({}, '', url.pathname)
}

// 로그아웃
export function logout() {
  localStorage.removeItem('jira_access_token')
  localStorage.removeItem('jira_refresh_token')
  localStorage.removeItem('jira_token_expires_at')
  localStorage.removeItem('jira_cloud_id')
  localStorage.removeItem('jira_site_name')
  localStorage.removeItem('jira_user')
}

// 로그인 상태 확인
export function isLoggedIn() {
  return !!localStorage.getItem('jira_access_token')
}

// 저장된 사용자 정보 (손상된 JSON이 있어도 throw하지 않음 → 호출부 방어적 처리 생략 가능)
export function getSavedUser() {
  const raw = localStorage.getItem('jira_user')
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

// 사용자 정보 저장
export function saveUser(user) {
  localStorage.setItem('jira_user', JSON.stringify(user))
}
