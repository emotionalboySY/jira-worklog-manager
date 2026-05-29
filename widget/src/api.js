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

// ===== 종료(워크로그 생성) — src/utils.js의 워크로그 로직을 미러 =====
const LUNCH_START = 11 * 60 + 30 // 11:30
const LUNCH_END = 12 * 60 + 30   // 12:30

function jiraTzOffset() {
  const off = new Date().getTimezoneOffset()
  const sign = off <= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`
}
function jiraStarted(dateStr, hhmm) {
  const [h = '00', m = '00'] = hhmm.split(':')
  return `${dateStr}T${h.padStart(2, '0')}:${m.padStart(2, '0')}:00.000${jiraTzOffset()}`
}
// 점심(11:30~12:30) 제외하고 worklog 구간을 분할 → [{ started, seconds }]
function worklogPieces(dateStr, startMin, endMin) {
  const ranges = []
  if (endMin <= LUNCH_START || startMin >= LUNCH_END) ranges.push([startMin, endMin])
  else {
    if (startMin < LUNCH_START) ranges.push([startMin, LUNCH_START])
    if (endMin > LUNCH_END) ranges.push([LUNCH_END, endMin])
  }
  const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
  return ranges.filter(([s, e]) => e > s).map(([s, e]) => ({ started: jiraStarted(dateStr, toHHMM(s)), seconds: (e - s) * 60 }))
}
function textToAdf(text) {
  return { type: 'doc', version: 1, content: text ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : [] }
}

// 세션의 각 구간을 점심 제외해 worklog 조각으로 환산(미리보기/제출 공용).
// 활성(열린) 구간은 현재 시각까지로 계산.
export function sessionWorklogs(session) {
  const out = []
  for (const seg of session.segments || []) {
    const start = new Date(seg.start)
    const end = seg.end ? new Date(seg.end) : new Date()
    if (end <= start) continue
    const dateStr = ymd(start)
    const startMin = start.getHours() * 60 + start.getMinutes()
    const endMin = end.getHours() * 60 + end.getMinutes()
    out.push(...worklogPieces(dateStr, startMin, endMin))
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

// 세션 종료: 구간별 worklog 생성(점심 제외). 성공 건수 반환. (세션 제거는 호출부가 remove로 처리)
export async function finishSession(session, comment) {
  const token = await ensureAccessToken()
  if (!token) throw new Error('not-authed')
  const cloudId = await getCloudId(token)
  if (!cloudId) throw new Error('cloudId를 확인할 수 없습니다.')
  const pieces = sessionWorklogs(session)
  if (!pieces.length) throw new Error('기록할 시간이 없습니다(점심 제외 후 0분).')
  let count = 0
  for (const p of pieces) {
    await createWorklog(token, cloudId, session.issueKey, { started: p.started, seconds: p.seconds, comment })
    count++
  }
  return count
}
