// 백엔드(공유 세션) + Jira API 호출. http 플러그인 fetch로 CORS 우회.
import { fetch } from '@tauri-apps/plugin-http'
import { CONFIG } from './config.js'
import { ensureAccessToken, refreshAccessToken, getTokens } from './auth.js'

// 인증 헤더를 붙여 호출하고, 401이면 1회 갱신 후 재시도.
async function authedFetch(url, options = {}) {
  let token = await ensureAccessToken()
  if (!token) { const e = new Error('not-authed'); e.code = 'not-authed'; throw e }
  const doFetch = (t) => fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${t}` },
  })
  let res = await doFetch(token)
  if (res.status === 401) {
    const ok = await refreshAccessToken()
    if (!ok) { const e = new Error('unauthorized'); e.code = 'unauthorized'; throw e }
    token = (await getTokens()).accessToken
    res = await doFetch(token)
  }
  return res
}

// 현재 세션 상태 조회 → { sessions, rev }
export async function getSessions() {
  const res = await authedFetch(`${CONFIG.apiBase}/api/sessions`)
  if (!res.ok) throw new Error(`sessions GET ${res.status}`)
  return res.json()
}

// 세션 변이 → { status, data:{ sessions, rev } }
export async function postSessionAction(action, payload) {
  const res = await authedFetch(`${CONFIG.apiBase}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

// 오늘 날짜의 내 워크로그 합계(분) — Jira에 직접 조회.
// 진행 중(미제출) 세션 경과는 별도로 더해 표시한다.
export async function getTodayLoggedMinutes() {
  const token = await ensureAccessToken()
  if (!token) return 0
  // cloudId 확보(접근 가능 리소스 첫 사이트)
  const cloudId = await getCloudId(token)
  if (!cloudId) return 0
  const myAccountId = await getMyAccountId(token, cloudId)
  if (!myAccountId) return 0

  const today = ymd(new Date())
  const jql = `worklogAuthor = currentUser() AND worklogDate = "${today}"`
  const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=worklog&maxResults=100`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  if (!res.ok) return 0
  const data = await res.json().catch(() => null)
  const issues = data?.issues || []
  const start = new Date(today + 'T00:00:00')
  const end = new Date(today + 'T23:59:59.999')
  let totalSec = 0
  for (const issue of issues) {
    const list = issue.fields?.worklog?.worklogs || []
    for (const w of list) {
      if (w.author?.accountId !== myAccountId) continue
      const s = new Date(w.started)
      if (s >= start && s <= end) totalSec += w.timeSpentSeconds || 0
    }
  }
  return Math.round(totalSec / 60)
}

// ----- 내부 캐시(앱 실행 동안) -----
let _cloudId = null
let _accountId = null

async function getCloudId(token) {
  if (_cloudId) return _cloudId
  const res = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) return null
  const list = await res.json().catch(() => null)
  _cloudId = Array.isArray(list) && list[0]?.id
  return _cloudId
}

async function getMyAccountId(token, cloudId) {
  if (_accountId) return _accountId
  const res = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) return null
  const data = await res.json().catch(() => null)
  _accountId = data?.accountId || null
  return _accountId
}

function ymd(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
