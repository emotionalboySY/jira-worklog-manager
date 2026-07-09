// ========== Atlassian OAuth 2.0 (3LO) ==========
const CLIENT_ID = import.meta.env.VITE_ATLASSIAN_CLIENT_ID
// manage:jira-webhook — 3LO 동적 웹훅 등록/갱신(실시간 변경 감지)에 필요.
// ※ 콘솔(Permissions → Jira API)에도 이 scope를 켜고 재로그인해야 새 토큰에 반영됨.
const SCOPES = 'read:jira-work write:jira-work read:jira-user manage:jira-webhook offline_access'

function getRedirectUri() {
  return window.location.origin + '/'
}

// ========== 로그인 실패 사유 노출 ==========
// 외부 조직(타 회사 도메인) 사용자가 로그인에 실패했을 때 "왜 막혔는지"를 로그인 화면에
// 그대로 보여주기 위한 마지막 에러 보관소. Atlassian이 콜백 URL로 돌려주는 error 코드,
// 토큰 교환 실패, 접근 가능한 사이트 없음 등을 사용자 친화적 메시지로 변환해 담는다.
// 형태: { code, message, detail }
let lastAuthError = null
export function getLastAuthError() { return lastAuthError }
export function clearLastAuthError() { lastAuthError = null }

// OAuth/토큰 에러 코드 → 한국어 안내. 매일국어 외부 공유 맥락에서 흔한 원인(조직의 외부 앱
// 차단/관리자 승인 정책)을 함께 안내한다. description은 Atlassian 원문(디버그용)으로 보존.
function describeAuthError(code, description) {
  const map = {
    access_denied: '로그인 동의가 거부되었습니다. 회사 조직이 외부 앱 사용에 관리자 승인을 요구하는 경우일 수 있어요. 친구 회사의 Atlassian 관리자에게 이 앱 허용을 요청해야 할 수 있습니다.',
    unauthorized_client: '이 앱이 해당 계정/조직에서 인증을 허용받지 못했습니다. 조직의 외부 앱 차단 정책일 가능성이 큽니다.',
    invalid_scope: '요청한 권한(scope)이 거부되었습니다. 조직 정책으로 일부 권한이 막혔을 수 있어요.',
    server_error: 'Atlassian 인증 서버에서 일시적 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
    temporarily_unavailable: 'Atlassian 인증 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해주세요.',
  }
  return {
    code: code || 'unknown',
    message: map[code] || '로그인에 실패했습니다. 잠시 후 다시 시도하거나 아래 오류 코드를 확인해주세요.',
    detail: description || '',
  }
}

// 인증 URL 생성 후 리다이렉트
// prompt:'consent'는 매 로그인마다 동의 화면을 강제 → 새 scope(manage:jira-webhook)가
// 기존 동의 재사용으로 토큰에 안 실리는 문제를 방지한다. Atlassian이 이미 동의된 앱은
// 증분 동의를 건너뛰어 옛 scope 토큰을 발급할 수 있어, scope 추가 후에는 필수.
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
  const oauthError = params.get('error')
  const oauthErrorDesc = params.get('error_description')

  // Atlassian이 code 없이 error만 돌려준 경우(동의 거부/조직 차단/관리자 승인 필요 등).
  // 이전엔 cleanUrl로 사유를 지워버려 화면에 아무것도 안 떴다 → 이제 사유를 보관해 노출.
  if (!code) {
    if (oauthError) {
      lastAuthError = describeAuthError(oauthError, oauthErrorDesc)
      cleanUrl()
    }
    return false
  }

  // state 검증
  const savedState = sessionStorage.getItem('oauth_state')
  if (state !== savedState) {
    console.error('OAuth state 불일치')
    lastAuthError = { code: 'state_mismatch', message: '보안 검증(state)에 실패했습니다. 새 창/시크릿 모드 충돌일 수 있어요. 다시 시도해주세요.', detail: '' }
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
      // Atlassian/프록시가 준 error 코드를 그대로 변환해 노출
      lastAuthError = describeAuthError(data?.error || 'token_exchange_failed', data?.error_description)
      cleanUrl()
      return false
    }

    // 토큰 저장
    saveTokens(data)
    cleanUrl()

    // Cloud ID 가져오기 — 접근 가능한 Jira Cloud 사이트가 없으면 사실상 사용 불가.
    // 이 경우 토큰만 받고 화면이 텅 비는 대신, 토큰을 정리하고 명확히 안내한다.
    const cloudId = await fetchAndSaveCloudId()
    if (!cloudId) {
      logout()  // 토큰 등 정리 (reason 'user' → 자동 로그아웃 이벤트 미발행)
      lastAuthError = {
        code: 'no_site',
        message: '이 계정으로 접근 가능한 Jira Cloud 사이트가 없습니다. 회사가 Jira Cloud(*.atlassian.net)를 사용하는지, 그리고 그 계정에 접근 권한이 있는지 확인해주세요. (사내 Jira가 온프레미스(Server/Data Center)면 이 앱으로는 연결되지 않습니다.)',
        detail: '',
      }
      return false
    }

    return true
  } catch (err) {
    console.error('OAuth 콜백 처리 실패:', err)
    lastAuthError = { code: 'network', message: '로그인 처리 중 네트워크 오류가 발생했습니다. 잠시 후 다시 시도해주세요.', detail: err?.message || '' }
    cleanUrl()
    return false
  }
}

// 토큰 갱신.
// 1) 같은 탭의 동시 401: in-flight promise 캐시로 1회만 호출 (기존 동작 유지)
// 2) 멀티탭 동시 401: 토큰은 localStorage로 모든 탭이 공유하는데 in-flight 캐시는 탭 단위라,
//    두 탭이 동시에 refresh하면 회전형(rotating) refresh token이 충돌하고(재사용 감지 시
//    토큰 패밀리 폐기 가능) 실패한 탭의 logout이 성공한 탭의 새 토큰까지 지웠다.
//    → Web Locks API로 사이트 전역 직렬화 + 락 획득 후 "다른 탭이 이미 갱신했는지" 재확인.
// 3) 로그아웃은 (a) 서버가 4xx로 토큰을 실제 거부했고 (b) 실패한 refresh token이 여전히
//    저장값과 같을 때만 — 네트워크 오류/5xx나 타 컨텍스트가 이미 갱신한 경우엔 세션 유지.
let _refreshInflight = null
export async function refreshAccessToken() {
  if (_refreshInflight) return _refreshInflight
  // 락 대기 전 스냅샷 — 대기 중 다른 탭이 갱신을 끝내면 액세스 토큰이 달라진다
  const accessBefore = localStorage.getItem('jira_access_token')
  _refreshInflight = (async () => {
    const doLocked = async () => {
      // 다른 탭이 이미 갱신함 → 추가 API 호출 없이 성공 (호출부가 새 토큰을 다시 읽음)
      const accessNow = localStorage.getItem('jira_access_token')
      if (accessNow && accessNow !== accessBefore) return true
      const refreshToken = localStorage.getItem('jira_refresh_token')
      if (!refreshToken) return false
      try {
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        })
        const data = await res.json().catch(() => null)
        if (!res.ok) {
          console.error('토큰 갱신 실패:', res.status, data)
          // 4xx = Atlassian이 이 refresh token을 실제로 거부. 5xx/일시 장애는 세션 유지.
          if (res.status >= 400 && res.status < 500) maybeLogoutAfterRefreshFailure(refreshToken)
          return false
        }
        saveTokens(data)
        return true
      } catch (err) {
        // 네트워크 오류 — 토큰이 거부된 것이 아니므로 로그아웃하지 않음 (다음 시도에서 재갱신)
        console.error('토큰 갱신 실패(네트워크):', err)
        return false
      }
    }
    // Web Locks 미지원 환경(구형 브라우저)에서는 탭 내 직렬화만 유지
    if (navigator.locks?.request) {
      return navigator.locks.request('jira-token-refresh', doLocked)
    }
    return doLocked()
  })()
  try {
    return await _refreshInflight
  } finally {
    _refreshInflight = null
  }
}

// 갱신 거부 후 로그아웃 직전 재확인: 그 사이 다른 탭이 이미 새 토큰으로 갈아끼웠다면
// (저장된 refresh token이 실패한 것과 다름) 로그아웃하면 안 된다.
function maybeLogoutAfterRefreshFailure(failedRefreshToken) {
  const current = localStorage.getItem('jira_refresh_token')
  if (current === failedRefreshToken) logout({ reason: 'refresh-failed' })
}

// ===== 선제적 토큰 갱신 =====
// 만료가 임박했으면 401을 기다리지 않고 미리 refresh 한다. 모든 인증 호출(jiraFetch·세션
// 폴링)이 이 함수를 먼저 거쳐, 만료된 토큰으로 API를 때려 401이 쌓이는 것을 방지한다.
const REFRESH_SKEW_MS = 2 * 60 * 1000           // 만료 2분 전이면 미리 갱신
const AUTO_REFRESH_INTERVAL_MS = 4 * 60 * 1000  // 백그라운드 선제 갱신 점검 주기
let _autoRefreshTimer = null
let _visibilityBound = false

// 유효한 access token 확보. 만료 임박 시 선제 갱신, 갱신 실패 시 null.
export async function ensureAccessToken() {
  const accessToken = localStorage.getItem('jira_access_token')
  if (!accessToken) return null
  const expiresAt = parseInt(localStorage.getItem('jira_token_expires_at') || '0', 10)
  if (expiresAt && Date.now() > expiresAt - REFRESH_SKEW_MS) {
    const ok = await refreshAccessToken()
    if (!ok) return null
    return localStorage.getItem('jira_access_token')
  }
  return accessToken
}

// 앱이 열려 있는 동안 access token을 주기적으로 선제 갱신한다.
// 효과: (1) 사용자가 조회 액션을 하지 않아도 세션이 유지되고, (2) refresh token의 미사용(idle)
// 만료 타이머가 계속 리셋되어 재로그인 빈도가 급감한다. 백그라운드 탭은 브라우저가 타이머를
// 조일 수 있어, 탭으로 돌아올 때(visibilitychange)도 만료 여부를 점검한다.
export function startTokenAutoRefresh() {
  if (!_visibilityBound && typeof document !== 'undefined') {
    _visibilityBound = true
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && isLoggedIn()) ensureAccessToken().catch(() => {})
    })
  }
  if (_autoRefreshTimer) return
  const tick = async () => {
    _autoRefreshTimer = null
    if (isLoggedIn()) { try { await ensureAccessToken() } catch {} }
    if (isLoggedIn()) _autoRefreshTimer = setTimeout(tick, AUTO_REFRESH_INTERVAL_MS)
  }
  _autoRefreshTimer = setTimeout(tick, AUTO_REFRESH_INTERVAL_MS)
}

export function stopTokenAutoRefresh() {
  if (_autoRefreshTimer) { clearTimeout(_autoRefreshTimer); _autoRefreshTimer = null }
}

// 429 응답을 받으면 Retry-After만큼 기다렸다가 1회 재시도.
// Atlassian의 동적 rate limit 대응 (https://developer.atlassian.com/cloud/jira/platform/rate-limiting/).
async function fetchWithRateLimit(doFetch, token) {
  let res = await doFetch(token)
  if (res.status !== 429) return res
  const headerVal = res.headers.get('Retry-After') || res.headers.get('retry-after') || '1'
  const retrySec = Math.min(Math.max(parseInt(headerVal, 10) || 1, 1), 30)
  await new Promise(resolve => setTimeout(resolve, retrySec * 1000))
  return doFetch(token)
}

// Jira API 호출 (프록시 경유)
// 성공: JSON 응답 반환 (204 No Content나 JSON이 아닌 경우 null)
// 실패: HTTP 상태 에러는 throw하여 호출부 try/catch가 감지 가능하도록 함
export async function jiraFetch(path, options = {}) {
  const cloudId = localStorage.getItem('jira_cloud_id')
  // 만료 임박이면 호출 전에 선제 갱신 → 401 왕복 없이 최신 토큰으로 바로 요청
  const accessToken = await ensureAccessToken()

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

  let res = await fetchWithRateLimit(doFetch, accessToken)

  // 401이면 토큰 갱신 후 재시도 (재시도 안에서도 429는 한 번 더 백오프)
  if (res.status === 401) {
    const refreshed = await refreshAccessToken()
    if (!refreshed) return null
    const newToken = localStorage.getItem('jira_access_token')
    res = await fetchWithRateLimit(doFetch, newToken)
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
  // 일부 엔드포인트(예: POST /issueLink)는 201과 함께 빈 본문을 돌려준다.
  // content-type만 보고 res.json()을 부르면 "Unexpected end of JSON input"이 터지므로 방어적으로 처리.
  try {
    return await res.json()
  } catch {
    return null
  }
}

// 접근 가능한 리소스에서 Cloud ID 가져오기
// 접근 가능한 사이트가 있으면 cloudId(문자열) 반환, 없거나 실패 시 null.
// 콜백에서 반환값으로 "볼 수 있는 사이트가 있는지"를 판별한다.
async function fetchAndSaveCloudId() {
  const accessToken = localStorage.getItem('jira_access_token')
  if (!accessToken) return null

  try {
    const res = await fetch(`/api/proxy?url=${encodeURIComponent('https://api.atlassian.com/oauth/token/accessible-resources')}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    })

    if (!res.ok) {
      console.error('Cloud ID 조회 실패:', res.status)
      return null
    }

    const resources = await res.json()

    if (Array.isArray(resources) && resources.length > 0) {
      localStorage.setItem('jira_cloud_id', resources[0].id)
      localStorage.setItem('jira_site_name', resources[0].name)
      return resources[0].id
    }
    return null
  } catch (e) {
    console.error('Cloud ID 조회 실패:', e)
    return null
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

// URL에서 OAuth 파라미터 제거 (성공/실패 양쪽 케이스 커버)
function cleanUrl() {
  const url = new URL(window.location)
  url.searchParams.delete('code')
  url.searchParams.delete('state')
  url.searchParams.delete('error')
  url.searchParams.delete('error_description')
  window.history.replaceState({}, '', url.pathname)
}

// 로그아웃
// reason: 'user' (기본, 사용자가 명시적으로 로그아웃) | 'refresh-failed' (자동 만료 처리)
// 자동 만료 시에는 'jira-auth-cleared' 이벤트를 발행 → main.js가 받아 UI 전환 + 안내
export function logout({ reason = 'user' } = {}) {
  localStorage.removeItem('jira_access_token')
  localStorage.removeItem('jira_refresh_token')
  localStorage.removeItem('jira_token_expires_at')
  localStorage.removeItem('jira_cloud_id')
  localStorage.removeItem('jira_site_name')
  localStorage.removeItem('jira_user')
  if (reason !== 'user') {
    try { window.dispatchEvent(new CustomEvent('jira-auth-cleared', { detail: { reason } })) } catch {}
  }
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
