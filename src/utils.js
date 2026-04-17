// 순수 유틸 + state 기반 파생 셀렉터
import {
  state,
  ISSUE_TYPES,
  ISSUE_STATUSES,
  LUNCH_START,
  LUNCH_END,
  STATUS_ORDER,
  PROJECT_ORDER,
  CLOSED_CATEGORY,
} from './state.js'

// ========== 날짜/시간 ==========
export function toDateString(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function shiftDate(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + delta)
  return toDateString(d)
}

export function formatElapsed(startedAt) {
  const diff = Date.now() - startedAt.getTime()
  const hours = Math.floor(diff / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  const seconds = Math.floor((diff % 60000) / 1000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

// 점심시간 자동 계산: 작업 시간이 12:00~13:00과 겹치는 분 수 반환
export function calcLunchOverlap(startDate, endDate) {
  const startMinutes = startDate.getHours() * 60 + startDate.getMinutes()
  const endMinutes = endDate.getHours() * 60 + endDate.getMinutes()
  const overlapStart = Math.max(startMinutes, LUNCH_START)
  const overlapEnd = Math.min(endMinutes, LUNCH_END)
  return Math.max(0, overlapEnd - overlapStart)
}

export function formatMinutes(totalMinutes) {
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (h === 0) return `${m}분`
  if (m === 0) return `${h}시간`
  return `${h}시간 ${m}분`
}

export function formatHoursShort(minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (minutes === 0) return ''
  if (m === 0) return `${h}시간`
  if (h === 0) return `${m}분`
  return `${h}시간${m}분`
}

// ========== HTML ==========
// HTML 속성 이스케이프
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ========== 이슈 타입/상태 ==========
export function getTypeIcon(type) {
  return ISSUE_TYPES[type]?.icon || '•'
}

export function getTypeLabel(type) {
  return ISSUE_TYPES[type]?.label || type
}

// UI 표시용 상태명 축약 (원본은 title로 보존)
export function getShortStatusLabel(status) {
  if (status === '보류(Closed)') return '보류'
  return status
}

export function getStatusInfo(status) {
  return ISSUE_STATUSES[status] || { label: status, css: 'todo' }
}

// Jira statusCategory key → CSS 클래스
export function getStatusCss(categoryKey) {
  const map = {
    'new': 'todo',
    'indeterminate': 'in-progress',
    'done': 'done',
  }
  return map[categoryKey] || 'todo'
}

// ========== 이슈 키 ==========
export function getProjectFromKey(issueKey) {
  return issueKey.split('-')[0]
}

export function getIssueNumber(issueKey) {
  const parts = issueKey.split('-')
  return parseInt(parts[parts.length - 1], 10) || 0
}

export function getJiraIssueUrl(issueKey) {
  const siteName = localStorage.getItem('jira_site_name')
  if (!siteName) return null
  return `https://${siteName}.atlassian.net/browse/${issueKey}`
}

// 이슈 키를 Jira 페이지로 연결하는 링크로 렌더
export function renderIssueKeyLink(issueKey) {
  const url = getJiraIssueUrl(issueKey)
  if (!url) return `<span class="issue-key">${issueKey}</span>`
  return `<a class="issue-key issue-key-link" href="${url}" target="_blank" rel="noopener noreferrer" title="Jira에서 열기">${issueKey}</a>`
}

// ========== 이슈 필터/정렬 ==========
export function getActiveIssues() {
  return state.realIssues
}

export function sortIssues(issues) {
  return [...issues].sort((a, b) => {
    // 1. 상태순
    const statusDiff = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99)
    if (statusDiff !== 0) return statusDiff
    // 2. 프로젝트순
    const projDiff = (PROJECT_ORDER[getProjectFromKey(a.key)] ?? 99) - (PROJECT_ORDER[getProjectFromKey(b.key)] ?? 99)
    if (projDiff !== 0) return projDiff
    // 3. 일감 번호 내림차순
    return getIssueNumber(b.key) - getIssueNumber(a.key)
  })
}

export function filterClosedIssues(issues) {
  if (state.showClosedIssues) return issues
  return issues.filter(i => i.statusCategory !== CLOSED_CATEGORY)
}

export function filterSprintIssues(issues) {
  if (!state.showSprintOnly) return issues
  if (!state.activeSprintKeys) return issues
  return issues.filter(i => state.activeSprintKeys.has(i.key))
}

export function getFilteredIssues() {
  let issues = getActiveIssues()
  issues = filterClosedIssues(issues)
  issues = filterSprintIssues(issues)
  if (state.currentProject !== 'ALL') {
    issues = issues.filter(i => getProjectFromKey(i.key) === state.currentProject)
  }
  if (state.currentFilterTab !== 'all') {
    issues = issues.filter(i => i.role === state.currentFilterTab)
  }
  return sortIssues(issues)
}

export function getProjectIssues() {
  let issues = getActiveIssues()
  issues = filterClosedIssues(issues)
  issues = filterSprintIssues(issues)
  if (state.currentProject === 'ALL') return issues
  return issues.filter(i => getProjectFromKey(i.key) === state.currentProject)
}

// ========== 로그 ==========
export function getActiveLogs(dateStr) {
  return state.worklogsByDate[dateStr] || []
}

export function getLogMinutes(dateStr) {
  const logs = getActiveLogs(dateStr)
  return logs.reduce((sum, log) => {
    if (log.durationMinutes != null) return sum + log.durationMinutes
    const parts = log.duration.match(/(\d+)h|(\d+)m/g) || []
    let mins = 0
    parts.forEach(p => {
      if (p.endsWith('h')) mins += parseInt(p) * 60
      if (p.endsWith('m')) mins += parseInt(p)
    })
    return sum + mins
  }, 0)
}
