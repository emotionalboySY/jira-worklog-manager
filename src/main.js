import './style.css'
import flatpickr from 'flatpickr'
import 'flatpickr/dist/flatpickr.min.css'
import { Korean } from 'flatpickr/dist/l10n/ko.js'
import { login, logout, isLoggedIn, handleOAuthCallback, fetchCurrentUser, getSavedUser, saveUser } from './auth.js'
import { fetchMyIssues, fetchProjects, searchIssuesByKey } from './jira.js'

// ========== 목업 데이터 ==========
const MOCK_USER = {
  displayName: '서윤석',
  email: 'gs_k_bear17@naver.com',
}

const PROJECTS = [
  { key: 'ALL', name: '전체' },
  { key: 'DK', name: '매일국어' },
  { key: 'DKT', name: '매일국어T' },
  { key: 'RM', name: '리딩수학과학' },
  { key: 'DD', name: '독도' },
]

const LUNCH_START = 12 * 60 // 12:00 (분 단위)
const LUNCH_END = 13 * 60   // 13:00 (분 단위)

const MOCK_SESSIONS = [
  {
    issueKey: 'DKT-926',
    summary: '[문제은행] 신규활동추가 - 아콘과 대화하기',
    type: 'task',
    startedAt: new Date(Date.now() - 83 * 60 * 1000),
    status: 'active',
    interruptions: [],
  },
  {
    issueKey: 'DKT-100',
    summary: '[수업관리자] 학습 리포트 UI 개선',
    type: 'story',
    startedAt: new Date(Date.now() - 165 * 60 * 1000),
    status: 'paused',
    interruptions: [
      { start: new Date(Date.now() - 83 * 60 * 1000), end: null },
    ],
  },
]

const ISSUE_TYPES = {
  task:      { icon: '✓', label: '작업' },
  story:     { icon: '★', label: '스토리' },
  epic:      { icon: '⚡', label: '에픽' },
  hotfix:    { icon: '🔥', label: '핫픽스' },
  operation: { icon: '⚙', label: '운영' },
  bug:       { icon: '✕', label: '버그' },
}

const ISSUE_STATUSES = {
  todo:        { label: '할 일', css: 'todo' },
  inProgress:  { label: '진행 중', css: 'in-progress' },
  inReview:    { label: '검토 중', css: 'in-review' },
  done:        { label: '완료', css: 'done' },
}

const MOCK_ISSUES = [
  // DKT
  { key: 'DKT-926', summary: '[문제은행] 신규활동추가 - 아콘과 대화하기', type: 'task', status: 'inProgress', priority: '높음', role: 'assignee' },
  { key: 'DKT-928', summary: '[콘텐츠] 활동꾸러미 3-1 검토 요청', type: 'task', status: 'todo', priority: '보통', role: 'assignee' },
  { key: 'DKT-922', summary: '[선생님화면] 챔피언 선정 애니메이션 버그', type: 'bug', status: 'inProgress', priority: '높음', role: 'assignee' },
  { key: 'DKT-900', summary: '[수업관리자] 학습 리포트 UI 개선', type: 'story', status: 'inReview', priority: '보통', role: 'reporter' },
  { key: 'DKT-915', summary: '[본사관리자] 학원 과금 데이터 일괄 수정', type: 'operation', status: 'todo', priority: '높음', role: 'reporter' },
  { key: 'DKT-930', summary: '[v2.5] 차기 버전 기능 통합', type: 'epic', status: 'inProgress', priority: '높음', role: 'assignee' },
  { key: 'DKT-931', summary: '[선생님화면] 수업 중 앱 크래시 긴급 수정', type: 'hotfix', status: 'done', priority: '긴급', role: 'assignee' },
  // DK
  { key: 'DK-310', summary: '[학습] 오답노트 자동 생성 기능', type: 'story', status: 'inProgress', priority: '높음', role: 'assignee' },
  { key: 'DK-305', summary: '[관리자] 학원 결제 내역 조회 오류', type: 'bug', status: 'todo', priority: '긴급', role: 'reporter' },
  // DD
  { key: 'DD-150', summary: '[독서록] 독서록 제출 알림 기능', type: 'task', status: 'inProgress', priority: '보통', role: 'assignee' },
  { key: 'DD-148', summary: '[관리자] 학생 그룹 관리 개선', type: 'story', status: 'inReview', priority: '보통', role: 'watcher' },
  // RM
  { key: 'RM-88', summary: '[수학] 문제풀이 타이머 동기화 이슈', type: 'bug', status: 'inProgress', priority: '높음', role: 'watcher' },
  { key: 'RM-85', summary: '[과학] 실험 영상 콘텐츠 업로드', type: 'task', status: 'done', priority: '보통', role: 'assignee' },
]

// 날짜별 목업 로그 데이터
const MOCK_LOGS_BY_DATE = {
  '2026-04-16': [
    { issueKey: 'DKT-878', summary: '패치노트 작성', startTime: '08:59', endTime: '09:59', duration: '1h', comment: 'v2.4.1 패치노트 작성 완료', lunchDeducted: 0 },
    { issueKey: 'DKT-922', summary: '[선생님화면] 챔피언 선정 애니메이션 버그', startTime: '10:00', endTime: '13:07', duration: '2h 7m', comment: 'requestAnimationFrame 타이밍 이슈 수정', lunchDeducted: 60 },
    { issueKey: 'DKT-928', summary: '[콘텐츠] 활동꾸러미 3-1 검토 요청', startTime: '14:08', endTime: '14:58', duration: '50m', comment: '활동꾸러미 검토 및 피드백 전달', lunchDeducted: 0 },
  ],
  '2026-04-15': [
    { issueKey: 'DKT-900', summary: '[수업관리자] 학습 리포트 UI 개선', startTime: '09:10', endTime: '12:00', duration: '2h 50m', comment: '리포트 차트 컴포넌트 구현', lunchDeducted: 0 },
    { issueKey: 'DKT-915', summary: '[본사관리자] 학원 과금 데이터 일괄 수정', startTime: '13:00', endTime: '15:30', duration: '2h 30m', comment: '과금 SQL 스크립트 작성 및 검증', lunchDeducted: 0 },
    { issueKey: 'DK-310', summary: '[학습] 오답노트 자동 생성 기능', startTime: '15:45', endTime: '18:00', duration: '2h 15m', comment: '오답노트 API 설계', lunchDeducted: 0 },
  ],
  '2026-04-14': [
    { issueKey: 'DKT-922', summary: '[선생님화면] 챔피언 선정 애니메이션 버그', startTime: '09:00', endTime: '13:30', duration: '3h 30m', comment: '애니메이션 로직 분석 및 원인 파악', lunchDeducted: 60 },
    { issueKey: 'DD-150', summary: '[독서록] 독서록 제출 알림 기능', startTime: '14:00', endTime: '17:00', duration: '3h', comment: '푸시 알림 연동 작업', lunchDeducted: 0 },
  ],
  '2026-04-10': [
    { issueKey: 'DKT-926', summary: '[문제은행] 신규활동추가 - 아콘과 대화하기', startTime: '09:00', endTime: '12:00', duration: '3h', comment: '문제은행 UI 설계', lunchDeducted: 0 },
    { issueKey: 'DKT-930', summary: '[v2.5] 차기 버전 기능 통합', startTime: '13:00', endTime: '18:00', duration: '5h', comment: '기능 통합 브랜치 머지 및 충돌 해결', lunchDeducted: 0 },
  ],
  '2026-04-09': [
    { issueKey: 'RM-85', summary: '[과학] 실험 영상 콘텐츠 업로드', startTime: '09:30', endTime: '13:00', duration: '2h 30m', comment: '영상 인코딩 및 업로드', lunchDeducted: 60 },
    { issueKey: 'DK-310', summary: '[학습] 오답노트 자동 생성 기능', startTime: '14:00', endTime: '18:30', duration: '4h 30m', comment: 'DB 스키마 설계', lunchDeducted: 0 },
  ],
  '2026-04-08': [
    { issueKey: 'DKT-931', summary: '[선생님화면] 수업 중 앱 크래시 긴급 수정', startTime: '08:30', endTime: '13:00', duration: '3h 30m', comment: '크래시 원인 분석 및 핫픽스', lunchDeducted: 60 },
    { issueKey: 'DD-148', summary: '[관리자] 학생 그룹 관리 개선', startTime: '14:00', endTime: '17:30', duration: '3h 30m', comment: '그룹 CRUD API 구현', lunchDeducted: 0 },
  ],
  '2026-04-07': [
    { issueKey: 'DKT-900', summary: '[수업관리자] 학습 리포트 UI 개선', startTime: '09:00', endTime: '13:00', duration: '3h', comment: '리포트 와이어프레임 리뷰', lunchDeducted: 60 },
    { issueKey: 'DKT-922', summary: '[선생님화면] 챔피언 선정 애니메이션 버그', startTime: '14:00', endTime: '18:00', duration: '4h', comment: 'CSS 애니메이션 디버깅', lunchDeducted: 0 },
  ],
  '2026-04-03': [
    { issueKey: 'DKT-878', summary: '패치노트 작성', startTime: '09:00', endTime: '10:30', duration: '1h 30m', comment: 'v2.4.0 패치노트', lunchDeducted: 0 },
    { issueKey: 'DK-305', summary: '[관리자] 학원 결제 내역 조회 오류', startTime: '10:30', endTime: '13:00', duration: '1h 30m', comment: '결제 API 디버깅', lunchDeducted: 60 },
    { issueKey: 'RM-88', summary: '[수학] 문제풀이 타이머 동기화 이슈', startTime: '14:00', endTime: '18:00', duration: '4h', comment: 'WebSocket 동기화 로직 수정', lunchDeducted: 0 },
  ],
  '2026-04-02': [
    { issueKey: 'DKT-926', summary: '[문제은행] 신규활동추가 - 아콘과 대화하기', startTime: '09:00', endTime: '17:00', duration: '7h', comment: '기획서 검토 및 API 설계', lunchDeducted: 60 },
  ],
  '2026-04-01': [
    { issueKey: 'DD-150', summary: '[독서록] 독서록 제출 알림 기능', startTime: '09:00', endTime: '12:00', duration: '3h', comment: '알림 시스템 조사', lunchDeducted: 0 },
    { issueKey: 'DKT-915', summary: '[본사관리자] 학원 과금 데이터 일괄 수정', startTime: '13:00', endTime: '18:00', duration: '5h', comment: '데이터 마이그레이션 스크립트', lunchDeducted: 0 },
  ],
}

// ========== 실제 데이터 ==========
let realIssues = []       // Jira에서 가져온 이슈 목록
let realProjects = []     // Jira에서 가져온 프로젝트 목록
let issuesLoading = false
let issuesLoaded = false

// ========== 상태 ==========
let currentMainTab = 'issues'
let currentFilterTab = 'all'
let currentProject = 'ALL'
let currentPage = 1
let showClosedIssues = false
let pageSize = 20
let searchQuery = ''
let searchResults = null // null=검색모드 아님, []=검색 결과
let searchLoading = false

// 정렬 순서 (낮을수록 위에 표시)
const STATUS_ORDER = {
  '진행중': 0,
  '검토': 1,
  '배포대기': 2,
  '준비': 3,
  '대기': 4,
  '완료됨': 5,
  'Closed': 6,
}
const PROJECT_ORDER = { 'DK': 0, 'DKT': 1, 'DD': 2, 'RM': 3 }
const ROLE_ORDER = { 'assignee': 0, 'reporter': 1, 'watcher': 2 }
const CLOSED_STATUSES = ['완료됨', 'Closed']
let logDate = toDateString(new Date()) // 선택된 날짜
let logViewMode = 'calendar' // 'calendar' | 'list'
let calendarYear = new Date().getFullYear()
let calendarMonth = new Date().getMonth() // 0-indexed
let showModal = false
let showCancelConfirm = null // 취소 확인 대상 issueKey
let theme = localStorage.getItem('theme') || 'dark'

// ========== 테마 초기화 ==========
function applyTheme() {
  if (theme === 'light') {
    document.documentElement.classList.add('light')
  } else {
    document.documentElement.classList.remove('light')
  }
}

function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark'
  localStorage.setItem('theme', theme)
  applyTheme()
  render()
}

// ========== 유틸 ==========
function toDateString(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function formatDateKorean(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  const days = ['일', '월', '화', '수', '목', '금', '토']
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]})`
}

function shiftDate(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + delta)
  return toDateString(d)
}

function formatElapsed(startedAt) {
  const diff = Date.now() - startedAt.getTime()
  const hours = Math.floor(diff / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  const seconds = Math.floor((diff % 60000) / 1000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function getTypeIcon(type) {
  return ISSUE_TYPES[type]?.icon || '•'
}

function getTypeLabel(type) {
  return ISSUE_TYPES[type]?.label || type
}

function getStatusInfo(status) {
  return ISSUE_STATUSES[status] || { label: status, css: 'todo' }
}

// Jira statusCategory key → CSS 클래스
function getStatusCss(categoryKey) {
  const map = {
    'new': 'todo',
    'indeterminate': 'in-progress',
    'done': 'done',
  }
  return map[categoryKey] || 'todo'
}

function getProjectFromKey(issueKey) {
  return issueKey.split('-')[0]
}

// 점심시간 자동 계산: 작업 시간이 12:00~13:00과 겹치는 분 수 반환
function calcLunchOverlap(startDate, endDate) {
  const startMinutes = startDate.getHours() * 60 + startDate.getMinutes()
  const endMinutes = endDate.getHours() * 60 + endDate.getMinutes()
  const overlapStart = Math.max(startMinutes, LUNCH_START)
  const overlapEnd = Math.min(endMinutes, LUNCH_END)
  return Math.max(0, overlapEnd - overlapStart)
}

function formatMinutes(totalMinutes) {
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (h === 0) return `${m}분`
  if (m === 0) return `${h}시간`
  return `${h}시간 ${m}분`
}

function getLogMinutes(dateStr) {
  const logs = MOCK_LOGS_BY_DATE[dateStr] || []
  return logs.reduce((sum, log) => {
    const parts = log.duration.match(/(\d+)h|(\d+)m/g) || []
    let mins = 0
    parts.forEach(p => {
      if (p.endsWith('h')) mins += parseInt(p) * 60
      if (p.endsWith('m')) mins += parseInt(p)
    })
    return sum + mins
  }, 0)
}

function formatHoursShort(minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (minutes === 0) return ''
  if (m === 0) return `${h}시간`
  if (h === 0) return `${m}분`
  return `${h}시간${m}분`
}

// ========== 렌더링 ==========
function render() {
  if (flatpickrInstance) {
    flatpickrInstance.destroy()
    flatpickrInstance = null
  }
  const app = document.querySelector('#app')

  if (!isLoggedIn()) {
    app.innerHTML = renderLoginScreen()
    bindLoginEvents()
    return
  }

  app.innerHTML = `
    ${renderHeader()}
    ${renderActiveSessions()}
    ${renderTabs()}
    ${renderContent()}
    ${showModal ? renderModal() : ''}
    ${showCancelConfirm ? renderCancelConfirm() : ''}
  `
  bindEvents()
  startTimerUpdate()
}

function renderLoginScreen() {
  return `
    <div class="login-screen">
      <span class="header-logo" style="font-size: 28px;">Jira 작업 로그 매니저</span>
      <p class="login-desc">Jira 계정으로 로그인하여 작업 시간을 관리하세요.</p>
      <button class="btn btn-primary btn-login" id="btn-login">Jira로 로그인</button>
    </div>
  `
}

function bindLoginEvents() {
  const loginBtn = document.getElementById('btn-login')
  if (loginBtn) {
    loginBtn.addEventListener('click', () => login())
  }
}

function renderHeader() {
  return `
    <header class="header">
      <div class="header-left">
        <span class="header-logo">Jira 작업 로그 매니저</span>
      </div>
      <div class="header-right">
        <span class="user-info">${getSavedUser()?.displayName || ''}</span>
        <button class="btn-icon" id="btn-theme" title="테마 전환">
          ${theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <button class="btn btn-sm" id="btn-logout">로그아웃</button>
      </div>
    </header>
  `
}

function renderProjectSelector() {
  // 이슈에서 실제 사용되는 프로젝트 키 추출
  const usedProjectKeys = [...new Set(realIssues.map(i => getProjectFromKey(i.key)))]
  const projectList = realProjects.length > 0
    ? realProjects.filter(p => usedProjectKeys.includes(p.key))
    : PROJECTS.filter(p => p.key !== 'ALL')

  return `
    <div class="project-selector">
      <span class="project-selector-label">프로젝트</span>
      <button class="project-chip ${currentProject === 'ALL' ? 'active' : ''}" data-project="ALL">전체</button>
      ${projectList.map(p => `
        <button class="project-chip ${currentProject === p.key ? 'active' : ''}" data-project="${p.key}">
          ${p.name} (${p.key})
        </button>
      `).join('')}
    </div>
  `
}

function renderActiveSessions() {
  if (MOCK_SESSIONS.length === 0) {
    return `
      <div class="active-sessions">
        <div class="section-title">현재 작업</div>
        <div class="no-session">진행 중인 작업이 없습니다. 아래 이슈 목록에서 작업을 시작하세요.</div>
      </div>
    `
  }

  const cards = MOCK_SESSIONS.map(session => `
    <div class="session-card ${session.status}">
      <div class="session-info">
        <div class="session-issue">
          <span class="issue-key">${session.issueKey}</span>
          <span class="issue-summary">${session.summary}</span>
        </div>
        <div class="session-meta">
          <span class="session-status ${session.status}">
            ${session.status === 'active' ? '● 진행 중' : '⏸ 중단됨'}
          </span>
          <span>${session.startedAt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 시작</span>
        </div>
      </div>
      <div class="session-actions">
        <span class="session-timer" data-start="${session.startedAt.getTime()}" data-status="${session.status}">
          ${formatElapsed(session.startedAt)}
        </span>
        ${session.status === 'active' ? `
          <button class="btn btn-primary btn-sm" data-action="finish" data-key="${session.issueKey}">종료</button>
          <button class="btn btn-danger btn-sm" data-action="cancel" data-key="${session.issueKey}">취소</button>
        ` : `
          <button class="btn btn-primary btn-sm" data-action="finish" data-key="${session.issueKey}">종료</button>
          <button class="btn btn-sm" data-action="resume" data-key="${session.issueKey}">재개</button>
          <button class="btn btn-danger btn-sm" data-action="cancel" data-key="${session.issueKey}">취소</button>
        `}
      </div>
    </div>
  `).join('')

  return `
    <div class="active-sessions">
      <div class="section-title">현재 작업</div>
      ${cards}
    </div>
  `
}

function renderTabs() {
  const mainTabs = [
    { id: 'issues', label: '이슈 목록' },
    { id: 'logs', label: '작업 로그 기록' },
    { id: 'summary', label: '요약' },
  ]

  return `
    <div class="tabs-container">
      <div class="main-tabs">
        ${mainTabs.map(tab => `
          <button class="main-tab ${currentMainTab === tab.id ? 'active' : ''}" data-main-tab="${tab.id}">
            ${tab.label}
          </button>
        `).join('')}
      </div>
    </div>
  `
}

function renderContent() {
  switch (currentMainTab) {
    case 'issues': return renderIssuesTab()
    case 'logs': return renderLogsTab()
    case 'summary': return renderSummaryTab()
    default: return ''
  }
}

function getActiveIssues() {
  return issuesLoaded ? realIssues : MOCK_ISSUES
}

function sortIssues(issues) {
  return [...issues].sort((a, b) => {
    // 1. 상태순
    const statusDiff = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99)
    if (statusDiff !== 0) return statusDiff
    // 2. 프로젝트순
    const projDiff = (PROJECT_ORDER[getProjectFromKey(a.key)] ?? 99) - (PROJECT_ORDER[getProjectFromKey(b.key)] ?? 99)
    if (projDiff !== 0) return projDiff
    // 3. 역할순
    return (ROLE_ORDER[a.role] ?? 99) - (ROLE_ORDER[b.role] ?? 99)
  })
}

function filterClosedIssues(issues) {
  if (showClosedIssues) return issues
  return issues.filter(i => !CLOSED_STATUSES.includes(i.status))
}

function getFilteredIssues() {
  let issues = getActiveIssues()
  issues = filterClosedIssues(issues)
  if (currentProject !== 'ALL') {
    issues = issues.filter(i => getProjectFromKey(i.key) === currentProject)
  }
  if (currentFilterTab !== 'all') {
    issues = issues.filter(i => i.role === currentFilterTab)
  }
  return sortIssues(issues)
}

function getProjectIssues() {
  let issues = getActiveIssues()
  issues = filterClosedIssues(issues)
  if (currentProject === 'ALL') return issues
  return issues.filter(i => getProjectFromKey(i.key) === currentProject)
}

function renderIssuesTab() {
  const isSearchMode = searchResults !== null

  if (issuesLoading) {
    return `<div class="no-session">이슈 목록을 불러오는 중...</div>`
  }

  const projectIssues = getProjectIssues()
  const filters = [
    { id: 'all', label: '전체', count: projectIssues.length },
    { id: 'assignee', label: '할당됨', count: projectIssues.filter(i => i.role === 'assignee').length },
    { id: 'reporter', label: '보고자', count: projectIssues.filter(i => i.role === 'reporter').length },
    { id: 'watcher', label: '워칭', count: projectIssues.filter(i => i.role === 'watcher').length },
  ]

  const filtered = isSearchMode ? searchResults : getFilteredIssues()

  return `
    <div class="search-bar">
      <input type="text" class="search-input" id="issue-search" placeholder="이슈 키 검색 (예: 123, DKT-123)" value="${searchQuery}" />
      ${searchQuery ? `<button class="search-clear" id="search-clear">✕</button>` : ''}
      ${searchLoading ? `<span class="search-spinner"></span>` : ''}
    </div>
    ${!isSearchMode ? `
      ${renderProjectSelector()}
      <div class="filter-row">
        <div class="filter-tabs">
          ${filters.map(f => `
            <button class="filter-tab ${currentFilterTab === f.id ? 'active' : ''}" data-filter="${f.id}">
              ${f.label}<span class="count">${f.count}</span>
            </button>
          `).join('')}
        </div>
        <div class="filter-right">
          <label class="closed-toggle">
            <span class="custom-checkbox ${showClosedIssues ? 'checked' : ''}">
              <svg viewBox="0 0 12 12" fill="none"><polyline points="2.5 6 5 8.5 9.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
            <input type="checkbox" id="show-closed" ${showClosedIssues ? 'checked' : ''} />
            <span>완료/보류 일감 보기</span>
          </label>
          <select class="page-size-select" id="page-size">
            ${[10, 20, 30, 50].map(n => `<option value="${n}" ${pageSize === n ? 'selected' : ''}>${n}개씩</option>`).join('')}
          </select>
        </div>
      </div>
    ` : `
      <div class="search-result-info">검색 결과 ${filtered.length}건</div>
    `}
    <div class="issue-list">
      ${filtered.length === 0 ? `
        <div class="no-session">해당 조건에 맞는 이슈가 없습니다.</div>
      ` : paginateIssues(filtered).map(issue => {
        const statusCss = getStatusCss(issue.statusCategory || issue.status)
        const statusLabel = issue.statusCategory ? issue.status : getStatusInfo(issue.status).label
        const typeIcon = issue.typeIconUrl
          ? `<img class="issue-type-img" src="${issue.typeIconUrl}" alt="${issue.type}" title="${issue.type}" />`
          : `<span class="issue-type-icon ${issue.type}" title="${getTypeLabel(issue.type)}">${getTypeIcon(issue.type)}</span>`
        const typeLabel = issue.typeIconUrl ? issue.type : getTypeLabel(issue.type)
        return `
        <div class="issue-row" data-issue-key="${issue.key}">
          <div class="issue-left">
            ${typeIcon}
            <span class="issue-type-label">${typeLabel}</span>
            <span class="issue-key">${issue.key}</span>
            <span class="issue-summary">${issue.summary}</span>
          </div>
          <div class="issue-right">
            <span class="issue-status ${statusCss}">${statusLabel}</span>
            <span class="issue-tag ${issue.role}">
              ${{ assignee: '할당', reporter: '보고', watcher: '워칭' }[issue.role]}
            </span>
            <button class="btn btn-primary btn-sm btn-start" data-action="start" data-key="${issue.key}">시작</button>
          </div>
        </div>
        `
      }).join('')}
    </div>
    ${!isSearchMode ? renderPagination(filtered.length) : ''}
  `
}

function paginateIssues(issues) {
  const start = (currentPage - 1) * pageSize
  return issues.slice(start, start + pageSize)
}

function renderPagination(totalItems) {
  const totalPages = Math.ceil(totalItems / pageSize)
  if (totalPages <= 1) return ''

  const pages = []
  for (let i = 1; i <= totalPages; i++) {
    // 처음, 마지막, 현재 주변 2페이지만 표시
    if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
      pages.push(i)
    } else if (pages[pages.length - 1] !== '...') {
      pages.push('...')
    }
  }

  return `
    <div class="pagination">
      <button class="btn btn-sm" data-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''}>◀</button>
      ${pages.map(p => p === '...'
        ? `<span class="pagination-dots">...</span>`
        : `<button class="btn btn-sm ${p === currentPage ? 'btn-primary' : ''}" data-page="${p}">${p}</button>`
      ).join('')}
      <button class="btn btn-sm" data-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''}>▶</button>
      <span class="pagination-info">${totalItems}건</span>
    </div>
  `
}

function renderLogsTab() {
  return `
    <div class="log-toolbar">
      <div class="log-view-toggle">
        <button class="view-btn ${logViewMode === 'calendar' ? 'active' : ''}" data-log-view="calendar" title="달력 보기"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="12" height="11" rx="1.5"/><line x1="2" y1="6.5" x2="14" y2="6.5"/><line x1="5.5" y1="1.5" x2="5.5" y2="4.5"/><line x1="10.5" y1="1.5" x2="10.5" y2="4.5"/></svg></button>
        <button class="view-btn ${logViewMode === 'list' ? 'active' : ''}" data-log-view="list" title="목록 보기">☰</button>
      </div>
    </div>
    ${logViewMode === 'calendar' ? renderCalendarView() : renderListView()}
    ${renderLogDetail()}
  `
}

function renderCalendarView() {
  const todayStr = toDateString(new Date())

  // 해당 월의 첫날과 마지막날
  const firstDay = new Date(calendarYear, calendarMonth, 1)
  const lastDay = new Date(calendarYear, calendarMonth + 1, 0)

  // 일요일 기준 시작 요일
  const dayHeaders = ['일', '월', '화', '수', '목', '금', '토']
  const thuOffset = firstDay.getDay() // 일요일=0 기준 오프셋

  // 미래 월 방지
  const now = new Date()
  const isCurrentMonth = calendarYear === now.getFullYear() && calendarMonth === now.getMonth()
  const isFutureMonth = calendarYear > now.getFullYear() || (calendarYear === now.getFullYear() && calendarMonth > now.getMonth())

  const cells = []
  // 이전 달 빈 셀
  for (let i = 0; i < thuOffset; i++) {
    cells.push({ day: '', dateStr: '', empty: true })
  }
  // 해당 월 날짜 셀
  for (let d = 1; d <= lastDay.getDate(); d++) {
    const dateStr = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const minutes = getLogMinutes(dateStr)
    const isFuture = dateStr > todayStr
    cells.push({
      day: d,
      dateStr,
      minutes,
      isToday: dateStr === todayStr,
      isSelected: dateStr === logDate,
      isFuture,
      empty: false,
    })
  }

  return `
    <div class="calendar">
      <div class="calendar-header">
        <button class="btn btn-sm" id="cal-prev">◀</button>
        <span class="calendar-title">${calendarYear}년 ${calendarMonth + 1}월</span>
        <button class="btn btn-sm ${isFutureMonth || isCurrentMonth ? 'btn-disabled' : ''}" id="cal-next" ${isFutureMonth || isCurrentMonth ? 'disabled' : ''}>▶</button>
        ${!(isCurrentMonth && logDate === todayStr) ? `<button class="btn btn-primary btn-sm" id="cal-today">오늘</button>` : ''}
      </div>
      <div class="calendar-grid">
        ${dayHeaders.map(d => `<div class="calendar-weekday">${d}</div>`).join('')}
        ${cells.map(cell => {
          if (cell.empty) return `<div class="calendar-cell empty"></div>`
          const level = cell.isFuture ? 0 : cell.minutes <= 0 ? 0 : cell.minutes < 180 ? 1 : cell.minutes < 360 ? 2 : 3
          return `
            <div class="calendar-cell ${cell.isToday ? 'today' : ''} ${cell.isSelected ? 'selected' : ''} ${cell.isFuture ? 'future' : ''} level-${level}"
                 ${!cell.isFuture ? `data-cal-date="${cell.dateStr}"` : ''}>
              <span class="calendar-day">${cell.day}</span>
              ${cell.minutes > 0 ? `<span class="calendar-hours">${formatHoursShort(cell.minutes)}</span>` : ''}
            </div>
          `
        }).join('')}
      </div>
    </div>
  `
}

function renderListView() {
  const todayStr = toDateString(new Date())
  return `
    <div class="log-date-nav">
      <button class="btn btn-sm" id="log-prev">◀</button>
      <input type="text" class="log-date-picker-input" id="log-date-picker" value="${logDate}" readonly />
      <button class="btn btn-sm" id="log-next" ${logDate >= todayStr ? 'disabled' : ''}>▶</button>
      ${logDate !== todayStr ? `<button class="btn btn-primary btn-sm" id="log-today">오늘</button>` : ''}
    </div>
  `
}

function renderLogDetail() {
  const logs = MOCK_LOGS_BY_DATE[logDate] || []
  const totalMinutes = getLogMinutes(logDate)

  return `
    <div class="log-detail">
      <div class="log-detail-header">${formatDateKorean(logDate)}</div>
      ${logs.length === 0 ? `
        <div class="no-session">이 날짜에 기록된 작업 로그가 없습니다.</div>
      ` : `
        <div class="log-list">
          ${logs.map(log => `
            <div class="log-row">
              <span class="log-time-range">${log.startTime} → ${log.endTime}</span>
              <span class="log-duration">${log.duration}</span>
              <div class="log-issue">
                <span class="issue-key">${log.issueKey}</span>
                <span class="issue-summary">${log.summary}</span>
              </div>
              ${log.lunchDeducted > 0 ? `<span class="log-lunch-badge">점심 -${log.lunchDeducted}분</span>` : ''}
              <span class="log-comment">${log.comment}</span>
            </div>
          `).join('')}
        </div>
        <div class="log-summary">
          <span class="log-summary-label">총 작업 시간</span>
          <span class="log-summary-value">${formatMinutes(totalMinutes)}</span>
        </div>
      `}
    </div>
  `
}

function formatHoursKorean(hours) {
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  if (h === 0) return `${m}분`
  if (m === 0) return `${h}시간`
  return `${h}시간 ${m}분`
}

// 목요일~수요일 주간 데이터 생성
function getWeekData() {
  const today = new Date()
  const dayOfWeek = today.getDay() // 0=일, 1=월, ..., 4=목, 6=토
  // 현재 주의 목요일 찾기: 목=4
  const diffToThursday = (dayOfWeek < 4) ? dayOfWeek + 3 : dayOfWeek - 4
  const thursday = new Date(today)
  thursday.setDate(today.getDate() - diffToThursday)

  const days = ['일', '월', '화', '수', '목', '금', '토']
  const weekData = []
  // 목업 시간 데이터
  const mockHours = [3.95, 0, 0, 0, 0, 0, 0]

  for (let i = 0; i < 7; i++) {
    const d = new Date(thursday)
    d.setDate(thursday.getDate() + i)
    const isToday = d.toDateString() === today.toDateString()
    weekData.push({
      day: days[d.getDay()],
      date: `${d.getMonth() + 1}/${d.getDate()}`,
      hours: mockHours[i],
      today: isToday,
    })
  }
  return weekData
}

function renderSummaryTab() {
  const weekData = getWeekData()
  const totalWeekHours = weekData.reduce((sum, d) => sum + d.hours, 0)
  const workedDays = weekData.filter(d => d.hours > 0).length
  const avgHours = workedDays > 0 ? totalWeekHours / workedDays : 0

  return `
    <div class="summary-grid">
      <div class="summary-card">
        <div class="summary-card-label">오늘</div>
        <div class="summary-card-value">${formatHoursKorean(3.95)}</div>
        <div class="summary-card-sub">3개 작업 진행함</div>
      </div>
      <div class="summary-card">
        <div class="summary-card-label">이번 주</div>
        <div class="summary-card-value">${formatHoursKorean(totalWeekHours)}</div>
        <div class="summary-card-sub">${workedDays > 0 ? `${workedDays}일 작업 진행함` : '아직 기록 없음'}</div>
      </div>
      <div class="summary-card">
        <div class="summary-card-label">일 평균</div>
        <div class="summary-card-value">${workedDays > 0 ? formatHoursKorean(avgHours) : '-'}</div>
        <div class="summary-card-sub">이번 주 기준</div>
      </div>
    </div>
    <div class="weekly-chart">
      <div class="weekly-chart-title">이번 주 일별 작업 시간 (목~수)</div>
      <div class="chart-bars">
        ${weekData.map(d => `
          <div class="chart-bar-col">
            <span class="chart-bar-value">${d.hours > 0 ? formatHoursKorean(d.hours) : '-'}</span>
            <div class="chart-bar ${d.today ? 'today' : ''}" style="height: ${Math.max((d.hours / 10) * 100, 2)}%"></div>
            <span class="chart-bar-label">${d.day} ${d.date}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `
}

function renderModal() {
  // 목업: DKT-926 세션의 종료 모달
  const session = MOCK_SESSIONS[0]
  const now = new Date()
  const elapsedMs = now.getTime() - session.startedAt.getTime()
  const elapsedMinutes = Math.floor(elapsedMs / 60000)

  // 점심시간 자동 계산
  const lunchMinutes = calcLunchOverlap(session.startedAt, now)
  const actualMinutes = elapsedMinutes - lunchMinutes

  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal">
        <div class="modal-title">작업 종료 — ${session.issueKey}</div>
        <div class="modal-info">
          <span class="modal-info-label">경과 시간</span>
          <span class="modal-info-value">${formatMinutes(elapsedMinutes)}</span>
        </div>
        <div class="modal-info">
          <span class="modal-info-label">중단 시간</span>
          <span class="modal-info-value">0분</span>
        </div>
        ${lunchMinutes > 0 ? `
        <div class="modal-info">
          <span class="modal-info-label">점심시간 차감 (12:00~13:00)</span>
          <span class="modal-info-value deducted">-${formatMinutes(lunchMinutes)}</span>
        </div>
        ` : ''}
        <div class="modal-info">
          <span class="modal-info-label">실 작업 시간</span>
          <span class="modal-info-value">${formatMinutes(actualMinutes)}</span>
        </div>
        <div class="modal-field">
          <label class="modal-label">작업 내용 (코멘트)</label>
          <textarea class="modal-textarea" placeholder="작업 내용을 입력하세요..."></textarea>
        </div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">취소</button>
          <button class="btn btn-primary" id="modal-submit">Jira에 기록</button>
        </div>
      </div>
    </div>
  `
}

function renderCancelConfirm() {
  return `
    <div class="modal-overlay" id="cancel-overlay">
      <div class="modal">
        <div class="modal-title">작업 로깅 취소</div>
        <p style="color: var(--text); margin-bottom: 20px;">
          <strong style="color: var(--text-bright);">${showCancelConfirm}</strong> 작업에 대한 로깅을 취소하시겠습니까?<br>
          <span style="color: var(--text-dim); font-size: 12px;">기록되지 않은 작업 시간은 사라집니다.</span>
        </p>
        <div class="modal-actions">
          <button class="btn" id="cancel-confirm-no">아니오</button>
          <button class="btn btn-danger" id="cancel-confirm-yes">취소하기</button>
        </div>
      </div>
    </div>
  `
}

// ========== 이벤트 바인딩 ==========
function bindEvents() {
  // 테마 토글
  const themeBtn = document.getElementById('btn-theme')
  if (themeBtn) {
    themeBtn.addEventListener('click', toggleTheme)
  }

  // 로그아웃
  const logoutBtn = document.getElementById('btn-logout')
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      logout()
      render()
    })
  }

  // 프로젝트 선택
  document.querySelectorAll('.project-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      currentProject = chip.dataset.project
      currentFilterTab = 'all'
      currentPage = 1
      render()
    })
  })

  // 메인 탭
  document.querySelectorAll('.main-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      currentMainTab = tab.dataset.mainTab
      render()
    })
  })

  // 필터 탭
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      currentFilterTab = tab.dataset.filter
      currentPage = 1
      render()
    })
  })

  // 이슈 검색
  const searchInput = document.getElementById('issue-search')
  if (searchInput) {
    let debounceTimer
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value
      clearTimeout(debounceTimer)
      if (!searchQuery.trim()) {
        searchResults = null
        searchLoading = false
        render()
        // 렌더 후 포커스 복원
        document.getElementById('issue-search')?.focus()
        return
      }
      debounceTimer = setTimeout(() => performSearch(), 500)
    })
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(debounceTimer)
        performSearch()
      }
      if (e.key === 'Escape') {
        searchQuery = ''
        searchResults = null
        render()
      }
    })
  }

  const searchClearBtn = document.getElementById('search-clear')
  if (searchClearBtn) {
    searchClearBtn.addEventListener('click', () => {
      searchQuery = ''
      searchResults = null
      render()
      document.getElementById('issue-search')?.focus()
    })
  }

  // 완료/보류 토글
  const showClosedCheckbox = document.getElementById('show-closed')
  if (showClosedCheckbox) {
    showClosedCheckbox.addEventListener('change', (e) => {
      showClosedIssues = e.target.checked
      currentPage = 1
      render()
    })
  }

  // 페이지 사이즈
  const pageSizeSelect = document.getElementById('page-size')
  if (pageSizeSelect) {
    pageSizeSelect.addEventListener('change', (e) => {
      pageSize = parseInt(e.target.value)
      currentPage = 1
      render()
    })
  }

  // 페이지네이션
  document.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPage = parseInt(btn.dataset.page)
      render()
      // 이슈 목록 상단으로 스크롤
      document.querySelector('.issue-list')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  })

  // 뷰 토글 (달력/목록)
  document.querySelectorAll('.view-btn[data-log-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      logViewMode = btn.dataset.logView
      render()
    })
  })

  // 달력 월 네비게이션
  const calPrev = document.getElementById('cal-prev')
  if (calPrev) {
    calPrev.addEventListener('click', () => {
      calendarMonth--
      if (calendarMonth < 0) { calendarMonth = 11; calendarYear-- }
      render()
    })
  }

  const calNext = document.getElementById('cal-next')
  if (calNext && !calNext.disabled) {
    calNext.addEventListener('click', () => {
      const now = new Date()
      const nextMonth = calendarMonth + 1
      const nextYear = nextMonth > 11 ? calendarYear + 1 : calendarYear
      const nm = nextMonth > 11 ? 0 : nextMonth
      if (nextYear < now.getFullYear() || (nextYear === now.getFullYear() && nm <= now.getMonth())) {
        calendarMonth = nm
        calendarYear = nextYear
        render()
      }
    })
  }

  const calToday = document.getElementById('cal-today')
  if (calToday) {
    calToday.addEventListener('click', () => {
      const now = new Date()
      calendarYear = now.getFullYear()
      calendarMonth = now.getMonth()
      logDate = toDateString(now)
      render()
    })
  }

  // 달력 날짜 클릭
  document.querySelectorAll('[data-cal-date]').forEach(cell => {
    cell.addEventListener('click', () => {
      logDate = cell.dataset.calDate
      render()
    })
  })

  // 목록 뷰 날짜 네비게이션
  const logPrev = document.getElementById('log-prev')
  if (logPrev) {
    logPrev.addEventListener('click', () => {
      logDate = shiftDate(logDate, -1)
      render()
    })
  }

  const logNext = document.getElementById('log-next')
  if (logNext && !logNext.disabled) {
    logNext.addEventListener('click', () => {
      const next = shiftDate(logDate, 1)
      if (next <= toDateString(new Date())) {
        logDate = next
        render()
      }
    })
  }

  const logToday = document.getElementById('log-today')
  if (logToday) {
    logToday.addEventListener('click', () => {
      logDate = toDateString(new Date())
      render()
    })
  }

  const logDatePicker = document.getElementById('log-date-picker')
  if (logDatePicker) {
    flatpickrInstance = flatpickr(logDatePicker, {
      locale: Korean,
      dateFormat: 'Y년 m월 d일 (D)',
      defaultDate: logDate,
      maxDate: 'today',
      disableMobile: true,
      onChange: (selectedDates) => {
        if (selectedDates.length > 0) {
          logDate = toDateString(selectedDates[0])
          render()
        }
      },
    })
  }

  // 작업 종료 버튼
  document.querySelectorAll('[data-action="finish"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      showModal = true
      render()
    })
  })

  // 작업 취소 버튼 → 컨펌 모달
  document.querySelectorAll('[data-action="cancel"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      showCancelConfirm = btn.dataset.key
      render()
    })
  })

  // 종료 모달
  const overlay = document.getElementById('modal-overlay')
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        showModal = false
        render()
      }
    })
  }

  const modalCancel = document.getElementById('modal-cancel')
  if (modalCancel) {
    modalCancel.addEventListener('click', () => {
      showModal = false
      render()
    })
  }

  const modalSubmit = document.getElementById('modal-submit')
  if (modalSubmit) {
    modalSubmit.addEventListener('click', () => {
      showModal = false
      alert('(프로토타입) Jira에 worklog가 기록되었습니다.')
      render()
    })
  }

  // 취소 컨펌 모달
  const cancelOverlay = document.getElementById('cancel-overlay')
  if (cancelOverlay) {
    cancelOverlay.addEventListener('click', (e) => {
      if (e.target === cancelOverlay) {
        showCancelConfirm = null
        render()
      }
    })
  }

  const cancelNo = document.getElementById('cancel-confirm-no')
  if (cancelNo) {
    cancelNo.addEventListener('click', () => {
      showCancelConfirm = null
      render()
    })
  }

  const cancelYes = document.getElementById('cancel-confirm-yes')
  if (cancelYes) {
    cancelYes.addEventListener('click', () => {
      alert(`(프로토타입) ${showCancelConfirm} 작업 로깅이 취소되었습니다.`)
      showCancelConfirm = null
      render()
    })
  }
}

// ========== Flatpickr 인스턴스 ==========
let flatpickrInstance = null

// ========== 타이머 업데이트 ==========
let timerInterval = null

function startTimerUpdate() {
  if (timerInterval) clearInterval(timerInterval)
  timerInterval = setInterval(() => {
    document.querySelectorAll('.session-timer').forEach(el => {
      if (el.dataset.status === 'active') {
        const start = new Date(parseInt(el.dataset.start))
        el.textContent = formatElapsed(start)
      }
    })
  }, 1000)
}

// ========== 데이터 로드 ==========
async function loadIssues() {
  if (issuesLoading) return
  issuesLoading = true
  render()

  try {
    const [issues, projects] = await Promise.all([
      fetchMyIssues(),
      fetchProjects(),
    ])

    realIssues = issues
    realProjects = projects
    issuesLoaded = true
  } catch (e) {
    console.error('이슈 로드 실패:', e)
  }

  issuesLoading = false
  render()
}

async function performSearch() {
  if (!searchQuery.trim()) return
  searchLoading = true
  render()
  // 렌더 후 포커스 복원
  const input = document.getElementById('issue-search')
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length) }

  try {
    const projectKeys = realProjects.length > 0
      ? realProjects.map(p => p.key)
      : ['DK', 'DKT', 'DD', 'RM']
    searchResults = await searchIssuesByKey(searchQuery.trim(), projectKeys)
  } catch (e) {
    console.error('검색 실패:', e)
    searchResults = []
  }

  searchLoading = false
  render()
  document.getElementById('issue-search')?.focus()
}

// ========== 초기화 ==========
async function init() {
  applyTheme()

  // OAuth 콜백 처리 (로그인 후 리다이렉트된 경우)
  const callbackHandled = await handleOAuthCallback()

  // 로그인 상태면 사용자 정보 로드
  if (isLoggedIn() && !getSavedUser()) {
    try {
      const user = await fetchCurrentUser()
      if (user) saveUser(user)
    } catch (e) {
      console.error('사용자 정보 로드 실패:', e)
    }
  }

  render()

  // 로그인 상태면 이슈 목록 로드
  if (isLoggedIn()) {
    loadIssues()
  }
}

init()
