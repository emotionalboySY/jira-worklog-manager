// 백엔드(공유 세션) + Jira API 호출. http 플러그인 fetch로 CORS 우회.
import { fetch } from '@tauri-apps/plugin-http'
import { CONFIG } from './config.js'
import { ensureAccessToken, refreshAccessToken, getTokens } from './auth.js'
import { buildWorklogPiecesFromRange } from '../../lib/worklogLogic.js'

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

// ===== 종료(워크로그 생성) — 점심/자정 분할 로직은 웹앱과 공유(lib/worklogLogic.js) =====
function textToAdf(text) {
  return { type: 'doc', version: 1, content: text ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : [] }
}

// 세션의 각 구간을 자정 경계 + 점심 제외로 worklog 조각 환산(미리보기/제출 공용).
// 활성(열린) 구간은 현재 시각까지로 계산. 자정을 넘긴 구간도 날짜별로 정확히 기록된다.
export function sessionWorklogs(session) {
  const out = []
  for (const seg of session.segments || []) {
    const start = new Date(seg.start)
    const end = seg.end ? new Date(seg.end) : new Date()
    if (end <= start) continue
    out.push(...buildWorklogPiecesFromRange(start, end))
  }
  return out
}

async function createWorklog(token, cloudId, issueKey, { started, seconds, comment }) {
  const body = { started, timeSpentSeconds: seconds }
  if (comment) body.comment = textToAdf(comment)
  const res = await fetch(
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    }
  )
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`worklog ${res.status}: ${t.slice(0, 200)}`)
  }
}

// 특정 날짜(로컬) 내 worklog 중 가장 늦은 종료 시각(Date) 반환. 없으면 null.
// '직전 종료 시간으로' 기능용 — 세션 시작일 기준 마지막 worklog 종료 시각.
export async function getLatestWorklogEnd(date) {
  const token = await ensureAccessToken()
  if (!token) return null
  const cloudId = await getCloudId(token)
  if (!cloudId) return null
  const myAccountId = await getMyAccountId(token, cloudId)
  if (!myAccountId) return null
  const dateStr = ymd(date)
  const jql = `worklogAuthor = currentUser() AND worklogDate = "${dateStr}"`
  const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=worklog&maxResults=100`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  if (!res.ok) return null
  const data = await res.json().catch(() => null)
  const issues = data?.issues || []
  const dayStart = new Date(dateStr + 'T00:00:00')
  const dayEnd = new Date(dateStr + 'T23:59:59.999')
  let latest = null
  for (const issue of issues) {
    for (const w of issue.fields?.worklog?.worklogs || []) {
      if (w.author?.accountId !== myAccountId) continue
      const s = new Date(w.started)
      if (s < dayStart || s > dayEnd) continue
      const e = new Date(s.getTime() + (w.timeSpentSeconds || 0) * 1000)
      if (!latest || e > latest) latest = e
    }
  }
  return latest
}

// 내 진행 중 이슈 목록(일감 교체용). statusCategory != Done, 최근 갱신순, 최대 100건.
export async function fetchMyIssues() {
  const token = await ensureAccessToken()
  if (!token) throw new Error('not-authed')
  const cloudId = await getCloudId(token)
  if (!cloudId) throw new Error('cloudId를 확인할 수 없습니다.')
  const jql = `(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND statusCategory != "Done" ORDER BY updated DESC`
  const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,issuetype,status&maxResults=100`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`이슈 조회 실패 ${res.status}`)
  const data = await res.json().catch(() => null)
  return (data?.issues || []).map(i => ({
    key: i.key,
    summary: i.fields?.summary || '',
    type: i.fields?.issuetype?.name || '',
    typeIconUrl: i.fields?.issuetype?.iconUrl || '',
    status: i.fields?.status?.name || '',
    statusCategory: i.fields?.status?.statusCategory?.key || '',
  }))
}

// 워크로그 조각들을 from 인덱스부터 순서대로 기록. 반환: 기록 완료된 누적 조각 수.
// 중간 실패 시 에러에 .posted(성공 누적 수)를 실어 던진다 — 호출부가 재시도 시
// 이미 기록된 조각을 건너뛰고 이어서 기록할 수 있다 (중복 worklog 방지).
export async function postWorklogPieces(issueKey, pieces, comment, { from = 0 } = {}) {
  let posted = from
  let token, cloudId
  try {
    token = await ensureAccessToken()
    if (!token) throw new Error('not-authed')
    cloudId = await getCloudId(token)
    if (!cloudId) throw new Error('cloudId를 확인할 수 없습니다.')
  } catch (e) {
    e.posted = posted
    throw e
  }
  for (let i = from; i < pieces.length; i++) {
    try {
      await createWorklog(token, cloudId, issueKey, { started: pieces[i].started, seconds: pieces[i].seconds, comment })
      posted = i + 1
    } catch (e) {
      e.posted = posted
      throw e
    }
  }
  return posted
}
