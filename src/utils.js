// 순수 유틸 + state 기반 파생 셀렉터
import {
  state,
  ISSUE_TYPES,
  ISSUE_STATUSES,
  LUNCH_START,
  LUNCH_END,
  DEFAULT_STATUS_ORDER,
  DEFAULT_PROJECT_ORDER,
  CLOSED_CATEGORY,
} from './state.js'
import {
  buildWorklogPiecesFromTimes,
  computeRangeMinutes,
} from '../lib/worklogLogic.js'

// realProjects가 비어있을 때(초기 로딩 등) 사용할 프로젝트 키 fallback.
// 자동완성/검색이 realProjects 의존이라 빈 배열이면 검색이 동작하지 않으므로 기본값 보장.
export function getProjectKeysOrFallback() {
  return (state.realProjects && state.realProjects.length > 0)
    ? state.realProjects.map(p => p.key)
    : [...DEFAULT_PROJECT_ORDER]
}

// 사용자가 입력/편집 중일 수 있는 UI(모달/드롭다운)가 떠 있거나 로딩 중인지.
// 자동 새로고침(autoReload)·원격 세션 반영(sessionSync)이 전체 렌더로 DOM 입력값을
// 날리지 않도록 양쪽이 공유하는 단일 판정 — 새 모달 추가 시 여기에만 등록하면 된다.
export function isBusyUI() {
  return !!(
    state.showModal ||
    state.showCancelConfirm ||
    state.editingWorklog ||
    state.deletingWorklog ||
    state.showManualLog ||
    state.showSettings ||
    state.showSwapIssue ||
    state.showCreateIssue ||
    state.statusDropdown ||
    state.assigneeDropdown ||
    state.typeDropdown ||
    state.transitionFieldsModal ||
    state.issueDetailModal ||
    state.issuesLoading ||
    state.worklogsLoading
  )
}

// 비동기 액션 동안 버튼을 스피너로 잠그는 패턴(Jira 등록/삭제 등) 공통화.
// fn이 throw하면 원래 라벨로 복구 후 다시 throw.
// extraDisabled: 같이 잠궈야 할 버튼들(취소 등)
export async function withSpinner(btn, fn, extraDisabled = []) {
  if (!btn) return fn()
  const originalLabel = btn.innerHTML
  btn.disabled = true
  btn.classList.add('is-loading')
  btn.innerHTML = '<span class="btn-spinner"></span>'
  for (const el of extraDisabled) { if (el) el.disabled = true }
  try {
    return await fn()
  } finally {
    btn.disabled = false
    btn.classList.remove('is-loading')
    btn.innerHTML = originalLabel
    for (const el of extraDisabled) { if (el) el.disabled = false }
  }
}

// 사용자 설정(userPrefs) 기반 정렬 인덱스
function statusOrderIndex(status) {
  const order = state.userPrefs?.statusOrder || DEFAULT_STATUS_ORDER
  const i = order.indexOf(status)
  return i === -1 ? 999 : i
}
function projectOrderIndex(project) {
  const order = state.userPrefs?.projectOrder || DEFAULT_PROJECT_ORDER
  const i = order.indexOf(project)
  return i === -1 ? 999 : i
}

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

// Jira worklog API의 started 필드용 타임존 문자열 (+0900 형식, 콜론 없음)
export function getJiraTzOffset() {
  const offset = new Date().getTimezoneOffset()
  const sign = offset <= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`
}

// Jira worklog의 started 필드 빌더. timeStr이 "HH:mm" 또는 "HH:mm:ss" 어느 쪽이든 안전하게 처리
// (일부 브라우저/상태에서 <input type="time">이 "HH:mm:ss"를 반환해 중복 ":ss"가 붙는 문제 방지)
export function buildJiraStarted(dateStr, timeStr) {
  const [h = '00', m = '00'] = timeStr.split(':')
  const hh = h.padStart(2, '0')
  const mm = m.padStart(2, '0')
  return `${dateStr}T${hh}:${mm}:00.000${getJiraTzOffset()}`
}

// 사용자 설정에 저장된 기본 점심시간 → { start, end } (분 단위).
// 모달에서 점심시간을 따로 지정하지 않았을 때의 기본값으로 쓴다.
export function getDefaultLunch() {
  return {
    start: state.userPrefs?.lunchStart ?? LUNCH_START,
    end: state.userPrefs?.lunchEnd ?? LUNCH_END,
  }
}

// 점심시간(기본 11:30~12:30, lunch로 재정의 가능)을 피해 worklog 구간을 분리 생성.
// 종료 시간이 시작보다 이르면 자정을 넘긴 것으로 간주해 날짜 경계로도 분할 — lib/worklogLogic.js 위임(위젯과 공유).
// 반환: [{ started, seconds }, ...]
export function buildWorklogSegments(dateStr, startTime, endTime, lunch = getDefaultLunch()) {
  return buildWorklogPiecesFromTimes(dateStr, startTime, endTime, lunch)
}

// Jira API 에러 응답(JSON)에서 사람이 읽을 수 있는 메시지로 변환
export function formatJiraError(err) {
  const detail = err?.detail || ''
  try {
    const parsed = JSON.parse(detail)
    const msgs = []
    if (Array.isArray(parsed.errorMessages)) msgs.push(...parsed.errorMessages)
    if (parsed.errors && typeof parsed.errors === 'object') {
      for (const [k, v] of Object.entries(parsed.errors)) msgs.push(`${k}: ${v}`)
    }
    if (msgs.length) return msgs.join('\n')
  } catch {}
  return err?.message || '알 수 없는 오류가 발생했습니다.'
}

// 점심시간 구간과 겹치는 분 수 반환 (기본값은 사용자 설정의 점심시간).
// 자정을 넘기는 구간도 날짜별로 나눠 정확히 계산 (공유 로직 위임)
export function calcLunchOverlap(startDate, endDate, lunch = getDefaultLunch()) {
  return computeRangeMinutes(startDate, endDate, lunch).lunchMinutes
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

// "HH:MM" 형식으로 분 단위 값을 포맷
export function formatHHMM(minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// "HH:MM"(또는 "HH:MM:SS") → 분 단위 정수. 무효 입력이면 null.
// 일부 브라우저/상태에서 <input type="time">이 "HH:MM:SS"를 반환하므로 초도 허용(무시).
// (buildJiraStarted/lib의 dateAtTime과 동일한 관용성 — 안 그러면 점심시간이 조용히 무시됨)
export function parseHHMM(str) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(str || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

// 점심시간 범위 문자열 (예: "11:30~12:30"). 기본값은 사용자 설정의 점심시간.
export function formatLunchRange(lunch = getDefaultLunch()) {
  return `${formatHHMM(lunch.start)}~${formatHHMM(lunch.end)}`
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

// 이슈 키를 Jira 페이지로 연결하는 링크로 렌더 (프로젝트별 색상 적용용 data-project 포함)
export function renderIssueKeyLink(issueKey) {
  const project = getProjectFromKey(issueKey)
  const url = getJiraIssueUrl(issueKey)
  if (!url) return `<span class="issue-key" data-project="${project}">${issueKey}</span>`
  return `<a class="issue-key issue-key-link" data-project="${project}" href="${url}" target="_blank" rel="noopener noreferrer" title="Jira에서 열기">${issueKey}</a>`
}

// 상위 항목(에픽/스토리 등) 링크 렌더. 없으면 빈 문자열
// title에 이슈 타입 + 키 + 요약을 담아 호버로 확인 가능 (카드에는 키만 노출)
export function renderParentLink(parent) {
  if (!parent || !parent.key) return ''
  const url = getJiraIssueUrl(parent.key)
  const title = `${parent.type || '상위 항목'} · ${parent.key}${parent.summary ? ` · ${parent.summary}` : ''}`
  const iconHtml = parent.typeIconUrl
    ? `<img class="issue-parent-icon" src="${parent.typeIconUrl}" alt="${escapeHtml(parent.type || '')}" />`
    : ''
  const inner = `${iconHtml}<span class="issue-parent-key">${parent.key}</span>`
  if (!url) return `<span class="issue-parent" title="${escapeHtml(title)}">${inner}</span>`
  return `<a class="issue-parent issue-parent-link" href="${url}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(title)}">${inner}</a>`
}

// ========== 이슈 필터/정렬 ==========
export function getActiveIssues() {
  return state.realIssues
}

export function sortIssues(issues) {
  return [...issues].sort((a, b) => {
    // 1. 상태순
    const statusDiff = statusOrderIndex(a.status) - statusOrderIndex(b.status)
    if (statusDiff !== 0) return statusDiff
    // 2. 프로젝트순
    const projDiff = projectOrderIndex(getProjectFromKey(a.key)) - projectOrderIndex(getProjectFromKey(b.key))
    if (projDiff !== 0) return projDiff
    // 3. 일감 번호 내림차순 (고정)
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
      if (p.endsWith('h')) mins += parseInt(p, 10) * 60
      if (p.endsWith('m')) mins += parseInt(p, 10)
    })
    return sum + mins
  }, 0)
}
