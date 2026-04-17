import './style.css'
import flatpickr from 'flatpickr'
import 'flatpickr/dist/flatpickr.min.css'
import { Korean } from 'flatpickr/dist/l10n/ko.js'
import { login, logout, isLoggedIn, handleOAuthCallback, fetchCurrentUser, getSavedUser, saveUser } from './auth.js'
import { fetchMyIssues, fetchProjects, searchIssuesByKey, fetchMyWorklogs, updateWorklog, deleteWorklog, createWorklog, fetchIssueMeta, fetchActiveSprintIssueKeys } from './jira.js'

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

// ========== 세션 관리 (localStorage, segments 기반) ==========
// 세션 구조: { issueKey, summary, status, segments: [{ start, end }] }
// segments: 실제 작업한 구간 목록. end=null이면 현재 진행 중
const SESSIONS_KEY = 'work_sessions'

function loadSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    if (!raw) return []
    return JSON.parse(raw).map(s => ({
      ...s,
      segments: (s.segments || []).map(seg => ({
        start: new Date(seg.start),
        end: seg.end ? new Date(seg.end) : null,
      })),
    }))
  } catch { return [] }
}

function saveSessions(sessions) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
}

// 현재 active 세션의 마지막 segment를 닫음
function pauseActiveSession(sessions) {
  const active = sessions.find(s => s.status === 'active')
  if (active) {
    active.status = 'paused'
    const lastSeg = active.segments[active.segments.length - 1]
    if (lastSeg && !lastSeg.end) lastSeg.end = new Date()
  }
}

function addSession(issueKey, summary) {
  const sessions = loadSessions()
  const existing = sessions.find(s => s.issueKey === issueKey)
  if (existing) {
    // 이미 세션이 있으면 재개
    if (existing.status === 'paused') {
      pauseActiveSession(sessions)
      existing.status = 'active'
      existing.segments.push({ start: new Date(), end: null })
    }
    saveSessions(sessions)
    return true
  }
  // 기존 active 세션 자동 중단
  pauseActiveSession(sessions)
  sessions.push({
    issueKey,
    summary,
    status: 'active',
    segments: [{ start: new Date(), end: null }],
  })
  saveSessions(sessions)
  return true
}

function pauseSession(issueKey) {
  const sessions = loadSessions()
  const s = sessions.find(s => s.issueKey === issueKey)
  if (!s || s.status !== 'active') return
  s.status = 'paused'
  const lastSeg = s.segments[s.segments.length - 1]
  if (lastSeg && !lastSeg.end) lastSeg.end = new Date()
  saveSessions(sessions)
}

function resumeSession(issueKey) {
  const sessions = loadSessions()
  const s = sessions.find(s => s.issueKey === issueKey)
  if (!s || s.status !== 'paused') return
  // 기존 active 세션 자동 중단
  pauseActiveSession(sessions)
  s.status = 'active'
  s.segments.push({ start: new Date(), end: null })
  saveSessions(sessions)
}

function removeSession(issueKey) {
  const sessions = loadSessions().filter(s => s.issueKey !== issueKey)
  saveSessions(sessions)
}

// ========== 연반차 (localStorage) ==========
// type: 'full' (종일 연차) | 'am' (오전 반차) | 'pm' (오후 반차) | null
const DAY_OFFS_KEY = 'day_offs'

function loadDayOffs() {
  try {
    const raw = localStorage.getItem(DAY_OFFS_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : {}
  } catch { return {} }
}

function getDayOff(dateStr) {
  return loadDayOffs()[dateStr] || null
}

function setDayOff(dateStr, type) {
  const m = loadDayOffs()
  if (!type || type === 'none') delete m[dateStr]
  else m[dateStr] = type
  try { localStorage.setItem(DAY_OFFS_KEY, JSON.stringify(m)) } catch {}
}

// 연반차 상태를 근무 시간(분)으로 환산: 연차 8시간, 반차 4시간
function getDayOffMinutes(type) {
  if (type === 'full') return 480
  if (type === 'am' || type === 'pm') return 240
  return 0
}

function getDayOffLabel(type) {
  if (type === 'full') return '연차'
  if (type === 'am') return '오전 반차'
  if (type === 'pm') return '오후 반차'
  return ''
}

// ========== 즐겨찾는 이슈 (localStorage) ==========
const FAVORITES_KEY = 'favorite_issues'

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

function saveFavorites(list) {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(list)) } catch {}
}

function isFavorite(issueKey) {
  return loadFavorites().some(f => f.issueKey === issueKey)
}

function toggleFavorite(issueKey, summary) {
  const list = loadFavorites()
  const idx = list.findIndex(f => f.issueKey === issueKey)
  if (idx >= 0) {
    list.splice(idx, 1)
  } else {
    list.push({ issueKey, summary })
  }
  saveFavorites(list)
}

// 세션의 첫 시작 시각
function getSessionStartedAt(session) {
  return session.segments.length > 0 ? session.segments[0].start : new Date()
}

// 세션 총 활성 시간 (분)
function getSessionElapsedMinutes(session) {
  let totalMs = 0
  for (const seg of session.segments) {
    const end = seg.end || new Date()
    totalMs += end.getTime() - seg.start.getTime()
  }
  return Math.floor(totalMs / 60000)
}

// 구간별 정보 (종료 모달용)
function getSegmentDetails(session) {
  return session.segments.map(seg => {
    const start = seg.start
    const end = seg.end || new Date()
    const durationMinutes = Math.floor((end.getTime() - start.getTime()) / 60000)
    const lunchMinutes = calcLunchOverlap(start, end)
    return {
      start,
      end,
      durationMinutes,
      lunchMinutes,
      actualMinutes: Math.max(0, durationMinutes - lunchMinutes),
    }
  })
}

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

// 작업 로그 데이터
let worklogsByDate = {}           // { 'YYYY-MM-DD': [{ issueKey, summary, startTime, endTime, duration, durationMinutes, comment }] }
let worklogsLoading = false
let worklogsLoadedMonths = new Set()  // API 로드 완료된 월 ("YYYY-MM" 형식)

const ISSUES_CACHE_KEY = 'issues_cache'
const WORKLOG_CACHE_KEY = 'worklog_cache'
const WORKLOG_CACHE_MAX_MONTHS = 3

// ========== 이슈 캐시 ==========
function loadIssuesCache() {
  try {
    const raw = localStorage.getItem(ISSUES_CACHE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch { return null }
}

function saveIssuesCache(issues, projects) {
  try {
    localStorage.setItem(ISSUES_CACHE_KEY, JSON.stringify({ issues, projects, savedAt: Date.now() }))
  } catch (e) {
    console.warn('이슈 캐시 저장 실패:', e)
  }
}

// ========== 워크로그 캐시 ==========
function loadWorklogCache() {
  try {
    const raw = localStorage.getItem(WORKLOG_CACHE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch { return null }
}

function saveWorklogCache(monthKey, logs) {
  const cache = loadWorklogCache() || { months: {} }
  // 해당 월 데이터 저장
  cache.months[monthKey] = { data: logs, savedAt: Date.now() }
  // 최근 N개월만 유지 — 오래된 월 삭제
  const keys = Object.keys(cache.months).sort()
  while (keys.length > WORKLOG_CACHE_MAX_MONTHS) {
    delete cache.months[keys.shift()]
  }
  try {
    localStorage.setItem(WORKLOG_CACHE_KEY, JSON.stringify(cache))
  } catch (e) {
    console.warn('워크로그 캐시 저장 실패:', e)
  }
}

function getCachedMonth(monthKey) {
  const cache = loadWorklogCache()
  return cache?.months?.[monthKey]?.data || null
}

// 캐시 데이터를 worklogsByDate에 병합
function mergeLogs(logs) {
  for (const [date, entries] of Object.entries(logs)) {
    worklogsByDate[date] = entries
  }
}

// ========== 상태 ==========
let currentMainTab = 'issues'
let currentFilterTab = 'all'
let currentProject = 'ALL'
let currentPage = 1
let showClosedIssues = false
let showSprintOnly = false
let activeSprintKeys = null  // Set<string> | null (null=아직 로드 안됨)
let sprintLoading = false
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
  // Done 범주: 완료 계열 먼저, 보류 계열 나중
  '완료됨': 5,
  '완료': 5,
  '보류': 6,
  '보류(Closed)': 6,
  'Closed': 6,
}
const PROJECT_ORDER = { 'DK': 0, 'DKT': 1, 'DD': 2, 'RM': 3 }
const CLOSED_CATEGORY = 'done'  // Jira statusCategory key
let logDate = toDateString(new Date()) // 선택된 날짜
let calendarOpen = (localStorage.getItem('log_calendar_open') !== '0') // 기본 열림
let calendarYear = new Date().getFullYear()
let calendarMonth = new Date().getMonth() // 0-indexed
let summaryWeekOffset = 0   // 0=이번 주, -1=지난 주, ...
let showModal = null             // 종료 모달 대상 issueKey
let showCancelConfirm = null // 취소 확인 대상 issueKey
let editingWorklog = null    // 수정 중인 워크로그
let deletingWorklog = null   // 삭제 확인 중인 워크로그
let showManualLog = null     // 수동 작업 기록 모달 state: null | { issueKey, summary }
let manualIssueCheck = null  // 이슈 키 검증 결과: null | { status: 'checking'|'ok'|'error', key, summary, message }
let manualKeySearchTimer = null  // 이슈 키 자동완성 API debounce 타이머
let manualKeyActiveIdx = -1      // 키보드 네비게이션 선택 인덱스
let theme = localStorage.getItem('theme') || 'dark'
let favoritesPanelCollapsed = (localStorage.getItem('favorites_collapsed') === '1')

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

// UI 표시용 상태명 축약 (원본은 title로 보존)
function getShortStatusLabel(status) {
  if (status === '보류(Closed)') return '보류'
  return status
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

function getActiveLogs(dateStr) {
  if (issuesLoaded) {
    return worklogsByDate[dateStr] || []
  }
  return MOCK_LOGS_BY_DATE[dateStr] || []
}

function getLogMinutes(dateStr) {
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

function formatHoursShort(minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (minutes === 0) return ''
  if (m === 0) return `${h}시간`
  if (h === 0) return `${m}분`
  return `${h}시간${m}분`
}

// ========== 컨텍스트 메뉴 ==========
let activeContextMenu = null
let contextMenuCloseHandler = null

function getJiraIssueUrl(issueKey) {
  const siteName = localStorage.getItem('jira_site_name')
  if (!siteName) return null
  return `https://${siteName}.atlassian.net/browse/${issueKey}`
}

// 이슈 키를 Jira 페이지로 연결하는 링크로 렌더
function renderIssueKeyLink(issueKey) {
  const url = getJiraIssueUrl(issueKey)
  if (!url) return `<span class="issue-key">${issueKey}</span>`
  return `<a class="issue-key issue-key-link" href="${url}" target="_blank" rel="noopener noreferrer" title="Jira에서 열기">${issueKey}</a>`
}

function showContextMenu(e, issueKey, summary) {
  e.preventDefault()
  e.stopPropagation()
  hideContextMenu()

  const menu = document.createElement('div')
  menu.className = 'context-menu'
  menu.innerHTML = `
    <div class="context-menu-item" data-ctx="manual-log">이 이슈에 수동 기록</div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" data-ctx="key">이슈 키(${issueKey}) 복사</div>
    <div class="context-menu-item" data-ctx="summary">이슈 요약 복사</div>
    <div class="context-menu-item" data-ctx="link">이슈 링크 복사</div>
  `

  document.body.appendChild(menu)

  // 화면 밖으로 나가지 않도록 위치 조정
  const rect = menu.getBoundingClientRect()
  const x = Math.min(e.clientX, window.innerWidth - rect.width - 8)
  const y = Math.min(e.clientY, window.innerHeight - rect.height - 8)
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  activeContextMenu = menu

  menu.querySelectorAll('.context-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.ctx
      if (action === 'manual-log') {
        showManualLog = { issueKey, summary }
        manualIssueCheck = { status: 'ok', key: issueKey, summary }
        hideContextMenu()
        render()
        return
      }
      let text = ''
      if (action === 'key') text = issueKey
      else if (action === 'summary') text = summary
      else if (action === 'link') text = getJiraIssueUrl(issueKey) || issueKey
      navigator.clipboard.writeText(text).then(() => {
        showToast('클립보드에 복사되었습니다.', '✓')
      })
      hideContextMenu()
    })
  })

  // 메뉴 외부 클릭/우클릭 시 닫기
  contextMenuCloseHandler = () => hideContextMenu()
  setTimeout(() => {
    document.addEventListener('click', contextMenuCloseHandler)
    document.addEventListener('contextmenu', contextMenuCloseHandler)
  }, 0)
}

function hideContextMenu() {
  if (activeContextMenu) {
    activeContextMenu.remove()
    activeContextMenu = null
  }
  if (contextMenuCloseHandler) {
    document.removeEventListener('click', contextMenuCloseHandler)
    document.removeEventListener('contextmenu', contextMenuCloseHandler)
    contextMenuCloseHandler = null
  }
}

// ========== 토스트 알림 ==========
function ensureToastContainer() {
  if (!document.getElementById('toast-container')) {
    const el = document.createElement('div')
    el.id = 'toast-container'
    el.className = 'toast-container'
    document.body.appendChild(el)
  }
  return document.getElementById('toast-container')
}

function showToast(message, icon = 'ℹ') {
  const container = ensureToastContainer()
  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${message}</span>`
  container.appendChild(toast)
  setTimeout(() => {
    toast.classList.add('toast-out')
    toast.addEventListener('animationend', () => toast.remove())
  }, 3000)
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
    ${renderFavoritesPanel()}
    ${showModal ? renderModal() : ''}
    ${showCancelConfirm ? renderCancelConfirm() : ''}
    ${editingWorklog ? renderEditWorklogModal() : ''}
    ${deletingWorklog ? renderDeleteWorklogConfirm() : ''}
    ${showManualLog ? renderManualLogModal() : ''}
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

function renderProjectSelector(isSearchMode = false) {
  // 이슈에서 실제 사용되는 프로젝트 키 추출
  const usedProjectKeys = [...new Set(realIssues.map(i => getProjectFromKey(i.key)))]
  const projectList = realProjects.length > 0
    ? realProjects.filter(p => usedProjectKeys.includes(p.key))
    : PROJECTS.filter(p => p.key !== 'ALL')

  return `
    <div class="project-selector">
      <span class="project-selector-label">프로젝트</span>
      <button class="project-chip ${!isSearchMode && currentProject === 'ALL' ? 'active' : ''}" data-project="ALL">전체</button>
      ${projectList.map(p => `
        <button class="project-chip ${!isSearchMode && currentProject === p.key ? 'active' : ''}" data-project="${p.key}">
          ${p.name} (${p.key})
        </button>
      `).join('')}
    </div>
  `
}

// 플로팅 즐겨찾기 패널 (우측 고정)
function renderFavoritesPanel() {
  const favorites = loadFavorites()
  const sessions = loadSessions()
  const sessionMap = new Map(sessions.map(s => [s.issueKey, s.status]))

  if (favoritesPanelCollapsed) {
    return `
      <div class="favorites-panel collapsed">
        <button class="favorites-toggle" id="favorites-toggle" title="즐겨찾는 이슈 펼치기">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><polygon points="8 1.5 10 6 15 6.6 11.3 10 12.3 14.5 8 12.3 3.7 14.5 4.7 10 1 6.6 6 6"/></svg>
          ${favorites.length > 0 ? `<span class="favorites-count">${favorites.length}</span>` : ''}
        </button>
      </div>
    `
  }

  const body = favorites.length === 0
    ? `<div class="favorites-empty">별표를 눌러 자주 작업하는 이슈를<br>즐겨찾기에 추가하세요.</div>`
    : favorites.map(fav => {
        const status = sessionMap.get(fav.issueKey)
        const btn = status === 'active'
          ? `<button class="btn btn-sm session-active-finish" data-action="finish" data-key="${fav.issueKey}" title="세션 종료"><span class="active-label">진행 중</span><span class="finish-label">종료</span></button>`
          : status === 'paused'
            ? `<button class="btn btn-sm" data-action="fav-start" data-key="${fav.issueKey}" data-summary="${(fav.summary || '').replace(/"/g, '&quot;')}">재개</button>`
            : `<button class="btn btn-primary btn-sm" data-action="fav-start" data-key="${fav.issueKey}" data-summary="${(fav.summary || '').replace(/"/g, '&quot;')}">시작</button>`
        return `
          <div class="favorite-item" data-issue-key="${fav.issueKey}" data-issue-summary="${(fav.summary || '').replace(/"/g, '&quot;')}">
            <div class="favorite-item-info">
              ${renderIssueKeyLink(fav.issueKey)}
              <span class="favorite-summary" title="${(fav.summary || '').replace(/"/g, '&quot;')}">${fav.summary || ''}</span>
            </div>
            <div class="favorite-item-actions">
              ${btn}
              <button class="btn-star-remove" data-action="fav-remove" data-key="${fav.issueKey}" title="즐겨찾기 해제">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>
              </button>
            </div>
          </div>
        `
      }).join('')

  return `
    <div class="favorites-panel expanded">
      <div class="favorites-header">
        <div class="favorites-title">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><polygon points="8 1.5 10 6 15 6.6 11.3 10 12.3 14.5 8 12.3 3.7 14.5 4.7 10 1 6.6 6 6"/></svg>
          <span>즐겨찾는 이슈</span>
          ${favorites.length > 0 ? `<span class="favorites-count-inline">${favorites.length}</span>` : ''}
        </div>
        <button class="favorites-collapse-btn" id="favorites-toggle" title="접기">▸</button>
      </div>
      <div class="favorites-body">${body}</div>
    </div>
  `
}

function renderActiveSessions() {
  const sessions = loadSessions()

  if (sessions.length === 0) {
    return `
      <div class="active-sessions">
        <div class="section-title-row"><span class="section-title">현재 작업</span><button class="btn btn-sm" id="btn-manual-log">+ 수동 기록</button></div>
        <div class="no-session">진행 중인 작업이 없습니다. 아래 이슈 목록에서 작업을 시작하세요.</div>
      </div>
    `
  }

  const cards = sessions.map(session => {
    const startedAt = getSessionStartedAt(session)
    const totalMinutes = getSessionElapsedMinutes(session)
    const segCount = session.segments.length
    return `
    <div class="session-card ${session.status}" data-issue-key="${session.issueKey}" data-issue-summary="${session.summary.replace(/"/g, '&quot;')}">
      <div class="session-info">
        <div class="session-issue">
          ${renderIssueKeyLink(session.issueKey)}
          <span class="issue-summary">${session.summary}</span>
        </div>
        <div class="session-meta">
          <span class="session-status ${session.status}">
            ${session.status === 'active' ? '● 진행 중' : '⏸ 중단됨'}
          </span>
          <span class="session-started-at">${startedAt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 시작${segCount > 1 ? ` · ${segCount}구간` : ''}</span>
          <button class="btn-link session-adjust-start" data-action="adjust-session-start" data-key="${session.issueKey}" title="직전 작업 로그 종료 시간으로 시작 시간 변경">직전 종료 시간으로</button>
        </div>
      </div>
      <div class="session-actions">
        <span class="session-timer" data-segments='${JSON.stringify(session.segments.map(s => ({ start: s.start.getTime(), end: s.end ? s.end.getTime() : null })))}' data-status="${session.status}">
          ${formatMinutes(totalMinutes)}
        </span>
        ${session.status === 'active' ? `
          <button class="btn btn-sm" data-action="pause" data-key="${session.issueKey}">중단</button>
          <button class="btn btn-primary btn-sm" data-action="finish" data-key="${session.issueKey}">종료</button>
          <button class="btn btn-danger btn-sm" data-action="cancel" data-key="${session.issueKey}">취소</button>
        ` : `
          <button class="btn btn-sm" data-action="resume" data-key="${session.issueKey}">재개</button>
          <button class="btn btn-primary btn-sm" data-action="finish" data-key="${session.issueKey}">종료</button>
          <button class="btn btn-danger btn-sm" data-action="cancel" data-key="${session.issueKey}">취소</button>
        `}
      </div>
    </div>
    `
  }).join('')

  return `
    <div class="active-sessions">
      <div class="section-title-row"><span class="section-title">현재 작업</span><button class="btn btn-sm" id="btn-manual-log">+ 수동 기록</button></div>
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

function getIssueNumber(issueKey) {
  const parts = issueKey.split('-')
  return parseInt(parts[parts.length - 1], 10) || 0
}

function sortIssues(issues) {
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

function filterClosedIssues(issues) {
  if (showClosedIssues) return issues
  return issues.filter(i => i.statusCategory !== CLOSED_CATEGORY)
}

function filterSprintIssues(issues) {
  if (!showSprintOnly) return issues
  if (!activeSprintKeys) return issues
  return issues.filter(i => activeSprintKeys.has(i.key))
}

function getFilteredIssues() {
  let issues = getActiveIssues()
  issues = filterClosedIssues(issues)
  issues = filterSprintIssues(issues)
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
  issues = filterSprintIssues(issues)
  if (currentProject === 'ALL') return issues
  return issues.filter(i => getProjectFromKey(i.key) === currentProject)
}

function renderIssuesTab() {
  const isSearchMode = searchResults !== null
  const sessions = loadSessions()
  const sessionMap = new Map(sessions.map(s => [s.issueKey, s.status]))

  if (issuesLoading && !issuesLoaded) {
    return `<div class="loading-container">
      <div class="loading-spinner"></div>
      <span class="loading-text">이슈 목록을 불러오는 중</span>
    </div>`
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
    ${renderProjectSelector(isSearchMode)}
    <div class="filter-row">
      <div class="filter-tabs">
        ${filters.map(f => `
          <button class="filter-tab ${!isSearchMode && currentFilterTab === f.id ? 'active' : ''}" data-filter="${f.id}">
            ${f.label}${!isSearchMode ? `<span class="count">${f.count}</span>` : ''}
          </button>
        `).join('')}
      </div>
      ${!isSearchMode ? `
        <div class="filter-right">
          <label class="closed-toggle">
            <span class="custom-checkbox ${showSprintOnly ? 'checked' : ''}">
              <svg viewBox="0 0 12 12" fill="none"><polyline points="2.5 6 5 8.5 9.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
            <input type="checkbox" id="show-sprint-only" ${showSprintOnly ? 'checked' : ''} ${sprintLoading ? 'disabled' : ''} />
            <span>현재 스프린트만 보기${sprintLoading ? ' (불러오는 중...)' : ''}</span>
          </label>
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
          <button class="btn btn-sm btn-refresh" id="btn-refresh-issues" ${issuesLoading ? 'disabled' : ''} title="이슈 목록 새로고침">
            ${issuesLoading ? '<span class="btn-spinner"></span>' : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8A5.5 5.5 0 1 1 12 4.5"/><polyline points="13.5 2 13.5 5 10.5 5"/></svg>'}
          </button>
        </div>
      ` : ''}
    </div>
    ${isSearchMode ? `<div class="search-result-info">검색 결과 ${filtered.length}건</div>` : ''}
    <div class="issue-list">
      ${filtered.length === 0 ? `
        <div class="no-session">해당 조건에 맞는 이슈가 없습니다.</div>
      ` : paginateIssues(filtered).map(issue => {
        const statusCss = getStatusCss(issue.statusCategory || issue.status)
        const rawStatus = issue.statusCategory ? issue.status : getStatusInfo(issue.status).label
        const statusLabel = getShortStatusLabel(rawStatus)
        const typeIcon = issue.typeIconUrl
          ? `<img class="issue-type-img" src="${issue.typeIconUrl}" alt="${issue.type}" title="${issue.type}" />`
          : `<span class="issue-type-icon ${issue.type}" title="${getTypeLabel(issue.type)}">${getTypeIcon(issue.type)}</span>`
        const typeLabel = issue.typeIconUrl ? issue.type : getTypeLabel(issue.type)
        return `
        <div class="issue-row" data-issue-key="${issue.key}" data-issue-summary="${issue.summary.replace(/"/g, '&quot;')}">
          <div class="issue-left">
            ${typeIcon}
            <span class="issue-type-label">${typeLabel}</span>
            ${renderIssueKeyLink(issue.key)}
            <span class="issue-summary">${issue.summary}</span>
          </div>
          <div class="issue-right">
            <button class="btn-star ${isFavorite(issue.key) ? 'is-favorite' : ''}" data-action="toggle-favorite" data-key="${issue.key}" title="${isFavorite(issue.key) ? '즐겨찾기 해제' : '즐겨찾기 추가'}">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="${isFavorite(issue.key) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="8 1.5 10 6 15 6.6 11.3 10 12.3 14.5 8 12.3 3.7 14.5 4.7 10 1 6.6 6 6"/></svg>
            </button>
            <span class="issue-status ${statusCss}" title="${rawStatus}">${statusLabel}</span>
            ${issue.role && issue.role !== 'none'
              ? `<span class="issue-tag ${issue.role}">${{ assignee: '할당', reporter: '보고', watcher: '워칭' }[issue.role]}</span>`
              : `<span class="issue-tag placeholder" aria-hidden="true">·</span>`
            }
            <button class="btn btn-sm btn-manual-inline" data-action="manual-log" data-key="${issue.key}" title="수동 기록">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><polyline points="8 4.5 8 8 10.5 9.5"/></svg>
            </button>
            ${sessionMap.get(issue.key) === 'active'
              ? `<button class="btn btn-sm btn-start session-active-finish" data-action="finish" data-key="${issue.key}" title="세션 종료"><span class="active-label">진행 중</span><span class="finish-label">종료</span></button>`
              : sessionMap.has(issue.key)
                ? `<button class="btn btn-sm btn-start" data-action="start" data-key="${issue.key}">재개</button>`
                : `<button class="btn btn-primary btn-sm btn-start" data-action="start" data-key="${issue.key}">시작</button>`
            }
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
      <button class="btn btn-sm btn-refresh" id="btn-refresh-worklogs" ${worklogsLoading ? 'disabled' : ''} title="작업 로그 새로고침">
        ${worklogsLoading ? '<span class="btn-spinner"></span>' : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8A5.5 5.5 0 1 1 12 4.5"/><polyline points="13.5 2 13.5 5 10.5 5"/></svg>'}
      </button>
      <button class="btn btn-sm" id="btn-calendar-toggle" title="${calendarOpen ? '달력 닫기' : '달력 열기'}">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="12" height="11" rx="1.5"/><line x1="2" y1="6.5" x2="14" y2="6.5"/><line x1="5.5" y1="1.5" x2="5.5" y2="4.5"/><line x1="10.5" y1="1.5" x2="10.5" y2="4.5"/></svg>
        <span>${calendarOpen ? '달력 닫기' : '달력 열기'}</span>
      </button>
    </div>
    ${calendarOpen ? renderCalendarView() : ''}
    ${renderDateNav()}
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
    const dayOffType = getDayOff(dateStr)
    const isFuture = dateStr > todayStr
    cells.push({
      day: d,
      dateStr,
      minutes,
      dayOffType,
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
        <div class="calendar-selectors">
          <select class="calendar-select" id="cal-year">
            ${(() => {
              const nowY = new Date().getFullYear()
              let opts = ''
              for (let y = nowY - 2; y <= nowY; y++) {
                opts += `<option value="${y}" ${y === calendarYear ? 'selected' : ''}>${y}년</option>`
              }
              return opts
            })()}
          </select>
          <select class="calendar-select" id="cal-month">
            ${(() => {
              const nowY = new Date().getFullYear()
              const nowM = new Date().getMonth()
              let opts = ''
              for (let m = 0; m < 12; m++) {
                const disabled = calendarYear === nowY && m > nowM
                opts += `<option value="${m}" ${m === calendarMonth ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${m + 1}월</option>`
              }
              return opts
            })()}
          </select>
        </div>
        ${worklogsLoading ? '<span class="calendar-spinner"></span>' : ''}
        <button class="btn btn-sm ${isFutureMonth || isCurrentMonth ? 'btn-disabled' : ''}" id="cal-next" ${isFutureMonth || isCurrentMonth ? 'disabled' : ''}>▶</button>
        ${!(isCurrentMonth && logDate === todayStr) ? `<button class="btn btn-primary btn-sm" id="cal-today">오늘</button>` : ''}
      </div>
      <div class="calendar-grid">
        ${dayHeaders.map(d => `<div class="calendar-weekday">${d}</div>`).join('')}
        ${cells.map(cell => {
          if (cell.empty) return `<div class="calendar-cell empty"></div>`
          const level = cell.isFuture ? 0 : cell.minutes <= 0 ? 0 : cell.minutes < 180 ? 1 : cell.minutes < 360 ? 2 : 3
          const dayOffClass = cell.dayOffType ? `day-off day-off-${cell.dayOffType}` : ''
          return `
            <div class="calendar-cell ${cell.isToday ? 'today' : ''} ${cell.isSelected ? 'selected' : ''} ${cell.isFuture ? 'future' : ''} level-${level} ${dayOffClass}"
                 ${!cell.isFuture ? `data-cal-date="${cell.dateStr}"` : ''}
                 ${cell.dayOffType ? `title="${getDayOffLabel(cell.dayOffType)}"` : ''}>
              <span class="calendar-day">${cell.day}</span>
              ${cell.minutes > 0 ? `<span class="calendar-hours">${formatHoursShort(cell.minutes)}</span>` : ''}
            </div>
          `
        }).join('')}
      </div>
    </div>
  `
}

function renderDateNav() {
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

function renderDayOffToggle() {
  const current = getDayOff(logDate)
  const options = [
    { value: 'none', label: '없음' },
    { value: 'full', label: '연차' },
    { value: 'am', label: '오전 반차' },
    { value: 'pm', label: '오후 반차' },
  ]
  return `
    <div class="day-off-toggle">
      <span class="day-off-label">연반차</span>
      <div class="day-off-options">
        ${options.map(o => `
          <button class="day-off-btn ${(current || 'none') === o.value ? 'active' : ''}" data-day-off="${o.value}">${o.label}</button>
        `).join('')}
      </div>
    </div>
  `
}

function renderLogDetail() {
  const logs = getActiveLogs(logDate)
  const totalMinutes = getLogMinutes(logDate)

  return `
    <div class="log-detail">
      ${renderDayOffToggle()}
      ${worklogsLoading && logs.length === 0 ? `
        <div class="loading-container">
          <div class="loading-spinner"></div>
          <span class="loading-text">작업 로그를 불러오는 중</span>
        </div>
      ` : logs.length === 0 ? `
        <div class="no-session">이 날짜에 기록된 작업 로그가 없습니다.</div>
      ` : `
        <div class="log-list">
          ${logs.map((log, idx) => `
            <div class="log-row" data-issue-key="${log.issueKey}" data-issue-summary="${(log.summary || '').replace(/"/g, '&quot;')}">
              <span class="log-time-range">${log.startTime} → ${log.endTime}</span>
              <span class="log-duration">${log.durationMinutes != null ? formatMinutes(log.durationMinutes) : log.duration}</span>
              <div class="log-issue">
                <div class="log-issue-header">
                  ${renderIssueKeyLink(log.issueKey)}
                  <span class="issue-summary">${log.summary}</span>
                  ${log.lunchDeducted > 0 ? `<span class="log-lunch-badge">점심 -${log.lunchDeducted}분</span>` : ''}
                </div>
                ${log.comment ? `<span class="log-comment">${log.comment}</span>` : ''}
              </div>
              ${log.worklogId ? `
                <div class="log-actions">
                  <button class="btn btn-sm" data-action="edit-log" data-idx="${idx}">수정</button>
                  <button class="btn btn-sm btn-danger" data-action="delete-log" data-idx="${idx}">삭제</button>
                </div>
              ` : ''}
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

// 주어진 오프셋의 목요일 구하기 (0=이번 주, -1=지난 주, ...)
function getThursdayByOffset(offset) {
  const today = new Date()
  const dayOfWeek = today.getDay()
  const diffToThursday = (dayOfWeek < 4) ? dayOfWeek + 3 : dayOfWeek - 4
  const thursday = new Date(today)
  thursday.setDate(today.getDate() - diffToThursday + offset * 7)
  return thursday
}

// 목요일 기준 주차 계산: 해당 월의 첫 번째 목요일 포함 주 = 1주차
function getWeekOfMonth(thursday) {
  const month = thursday.getMonth()
  const year = thursday.getFullYear()
  const firstDay = new Date(year, month, 1)
  const firstDow = firstDay.getDay()
  const firstThursday = 1 + ((4 - firstDow + 7) % 7)
  return Math.floor((thursday.getDate() - firstThursday) / 7) + 1
}

// 목요일~수요일 주간 데이터 생성 (실제 worklog 기반)
function getWeekData(offset) {
  const today = new Date()
  const thursday = getThursdayByOffset(offset)
  const days = ['일', '월', '화', '수', '목', '금', '토']
  const weekData = []

  for (let i = 0; i < 7; i++) {
    const d = new Date(thursday)
    d.setDate(thursday.getDate() + i)
    const dateStr = toDateString(d)
    const minutes = getLogMinutes(dateStr)
    const isToday = d.toDateString() === today.toDateString()
    const isFuture = d > today
    const dow = d.getDay()
    weekData.push({
      day: days[dow],
      date: `${String(d.getMonth() + 1).padStart(2, '0')}월 ${String(d.getDate()).padStart(2, '0')}일`,
      minutes: isFuture ? 0 : minutes,
      today: isToday,
      isFuture,
      weekend: dow === 0 || dow === 6,
    })
  }
  return { weekData, thursday }
}

// 요약 탭에 필요한 월들의 워크로그 로딩
function ensureSummaryWorklogs() {
  if (!isLoggedIn() || !issuesLoaded) return
  const thursday = getThursdayByOffset(summaryWeekOffset)
  const wednesday = new Date(thursday)
  wednesday.setDate(thursday.getDate() + 6)
  loadWorklogs(thursday.getFullYear(), thursday.getMonth())
  if (wednesday.getMonth() !== thursday.getMonth()) {
    loadWorklogs(wednesday.getFullYear(), wednesday.getMonth())
  }
}

function renderSummaryTab() {
  const isCurrentWeek = summaryWeekOffset === 0
  const { weekData, thursday } = getWeekData(summaryWeekOffset)
  const totalWeekMinutes = weekData.reduce((sum, d) => sum + d.minutes, 0)
  const workedDays = weekData.filter(d => d.minutes > 0).length
  const avgMinutes = workedDays > 0 ? Math.round(totalWeekMinutes / workedDays) : 0

  const weekMonth = thursday.getMonth() + 1
  const weekNum = getWeekOfMonth(thursday)

  // 현재 주일 때만 오늘 카드 표시
  let todayCard = ''
  if (isCurrentWeek) {
    const todayStr = toDateString(new Date())
    const todayMinutes = getLogMinutes(todayStr)
    const todayLogs = getActiveLogs(todayStr)
    todayCard = `
      <div class="summary-card">
        <div class="summary-card-label">오늘</div>
        <div class="summary-card-value">${todayMinutes > 0 ? formatMinutes(todayMinutes) : '-'}</div>
        <div class="summary-card-sub">${todayLogs.length > 0 ? `${todayLogs.length}개 작업 기록` : '아직 기록 없음'}</div>
      </div>
    `
  }

  return `
    <div class="summary-week-nav">
      <button class="btn btn-sm" id="summary-prev">◀</button>
      <span class="summary-week-title">${weekMonth}월 ${weekNum}주차</span>
      ${worklogsLoading ? '<span class="calendar-spinner"></span>' : ''}
      <button class="btn btn-sm ${isCurrentWeek ? 'btn-disabled' : ''}" id="summary-next" ${isCurrentWeek ? 'disabled' : ''}>▶</button>
      ${!isCurrentWeek ? `<button class="btn btn-primary btn-sm" id="summary-this-week">이번 주</button>` : ''}
    </div>
    <div class="summary-grid ${isCurrentWeek ? '' : 'two-col'}">
      ${todayCard}
      <div class="summary-card">
        <div class="summary-card-label">${isCurrentWeek ? '이번 주' : '주간 합계'}</div>
        <div class="summary-card-value">${totalWeekMinutes > 0 ? formatMinutes(totalWeekMinutes) : '-'}</div>
        <div class="summary-card-sub">${workedDays > 0 ? `${workedDays}일 작업 기록` : '기록 없음'}</div>
      </div>
      <div class="summary-card">
        <div class="summary-card-label">일 평균</div>
        <div class="summary-card-value">${workedDays > 0 ? formatMinutes(avgMinutes) : '-'}</div>
        <div class="summary-card-sub">${isCurrentWeek ? '이번 주 기준' : '해당 주 기준'}</div>
      </div>
    </div>
    <div class="weekly-chart">
      <div class="weekly-chart-title">${isCurrentWeek ? '금주' : ''}(${weekMonth}월 ${weekNum}주차) 일별 작업 시간</div>
      <div class="chart-bars">
        ${weekData.map(d => `
          <div class="chart-bar-col ${d.isFuture ? 'future' : ''} ${d.weekend ? 'weekend' : ''}">
            <span class="chart-bar-value">${d.minutes > 0 ? formatMinutes(d.minutes) : '-'}</span>
            <div class="chart-bar-track">
              <div class="chart-bar ${d.today ? 'today' : ''}" style="height: ${Math.max(Math.min((d.minutes / 480) * 100, 100), d.minutes > 0 ? 2 : 0)}%"></div>
            </div>
            <span class="chart-bar-label">${d.date} (${d.day})</span>
          </div>
        `).join('')}
      </div>
    </div>
  `
}

function renderModal() {
  const sessions = loadSessions()
  const session = sessions.find(s => s.issueKey === showModal)
  if (!session) return ''

  // 진행 중 세션이면 마지막 구간 닫아서 계산
  const details = getSegmentDetails(session)
  const totalActual = details.reduce((sum, d) => sum + d.actualMinutes, 0)
  const totalLunch = details.reduce((sum, d) => sum + d.lunchMinutes, 0)
  const totalDuration = details.reduce((sum, d) => sum + d.durationMinutes, 0)

  const fmtTime = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal">
        <div class="modal-title">작업 종료</div>
        <div class="modal-issue-info">
          <span class="issue-key">${session.issueKey}</span>
          <span class="modal-issue-summary">${session.summary}</span>
        </div>
        <div class="modal-section-label">작업 구간 (${details.length}건)</div>
        ${details.map((seg, i) => `
          <div class="modal-info">
            <span class="modal-info-label">${fmtTime(seg.start)} → ${fmtTime(seg.end)}</span>
            <span class="modal-info-value">${formatMinutes(seg.durationMinutes)}${seg.lunchMinutes > 0 ? ` <span class="deducted">(-${formatMinutes(seg.lunchMinutes)} 점심)</span>` : ''}</span>
          </div>
        `).join('')}
        <div class="modal-info" style="border-top: 1px solid var(--border); margin-top: 4px; padding-top: 12px;">
          <span class="modal-info-label">실 작업 시간 합계</span>
          <span class="modal-info-value">${formatMinutes(totalActual)}</span>
        </div>
        <div class="modal-field">
          <label class="modal-label">작업 내용 (코멘트)</label>
          <textarea class="modal-textarea" id="finish-comment" placeholder="작업 내용을 입력하세요..."></textarea>
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

function renderEditWorklogModal() {
  if (!editingWorklog) return ''
  const w = editingWorklog
  // 시작 시간 + 소요 시간(분)으로부터 종료 시간 역산
  const [sh, sm] = w.startTime.split(':').map(Number)
  const totalStartMin = sh * 60 + sm
  const totalEndMin = totalStartMin + (w.durationHours * 60 + w.durationMins)
  const endTime = `${String(Math.floor(totalEndMin / 60) % 24).padStart(2, '0')}:${String(totalEndMin % 60).padStart(2, '0')}`
  return `
    <div class="modal-overlay" id="edit-worklog-overlay">
      <div class="modal">
        <div class="modal-title">작업 로그 수정</div>
        <div class="modal-issue-info">
          <span class="issue-key">${w.issueKey}</span>
          <span class="modal-issue-summary">${w.summary}</span>
        </div>
        <div class="modal-field">
          <label class="modal-label">시작 시간</label>
          <input type="time" class="modal-input" id="edit-start-time" value="${w.startTime}" />
        </div>
        <div class="modal-field">
          <label class="modal-label">종료 시간</label>
          <div class="time-with-btn">
            <input type="time" class="modal-input" id="edit-end-time" value="${endTime}" />
            <button type="button" class="btn btn-sm" id="edit-end-now">지금</button>
          </div>
        </div>
        <div class="modal-field">
          <label class="modal-label">소요 시간</label>
          <div class="duration-readout" id="edit-duration-readout">-</div>
        </div>
        <div class="modal-field">
          <label class="modal-label">작업 내용</label>
          <textarea class="modal-textarea" id="edit-comment">${w.comment || ''}</textarea>
        </div>
        <div class="modal-actions">
          <button class="btn" id="edit-worklog-cancel">취소</button>
          <button class="btn btn-primary" id="edit-worklog-submit">저장</button>
        </div>
      </div>
    </div>
  `
}

function renderDeleteWorklogConfirm() {
  if (!deletingWorklog) return ''
  return `
    <div class="modal-overlay" id="delete-worklog-overlay">
      <div class="modal">
        <div class="modal-title">작업 로그 삭제</div>
        <p style="color: var(--text); margin-bottom: 20px;">
          <strong style="color: var(--text-bright);">${deletingWorklog.issueKey}</strong>의 작업 로그를 삭제하시겠습니까?<br>
          <span style="color: var(--text-dim); font-size: 12px;">삭제된 작업 로그는 복구할 수 없습니다.</span>
        </p>
        <div class="modal-actions">
          <button class="btn" id="delete-worklog-no">취소</button>
          <button class="btn btn-danger" id="delete-worklog-yes">삭제</button>
        </div>
      </div>
    </div>
  `
}

// 이슈 키 형식 검사 (예: DKT-123)
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/

function isValidIssueKeyFormat(key) {
  return ISSUE_KEY_PATTERN.test(key)
}

// 이미 로드된 이슈 목록에서 찾기 (API 호출 없이)
function findLoadedIssue(key) {
  const pool = [...getActiveIssues(), ...(searchResults || [])]
  return pool.find(i => i.key === key) || null
}

// 특정 날짜의 worklog 중 가장 늦은 endTime 반환 (없으면 null)
function getLatestEndTimeForDate(dateStr) {
  const logs = worklogsByDate[dateStr] || []
  if (logs.length === 0) return null
  return logs.reduce((max, l) => (l.endTime > max ? l.endTime : max), '00:00')
}

function renderManualLogModal() {
  const ctx = showManualLog || {}
  const todayStr = toDateString(new Date())
  const now = new Date()
  const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  // 시작 시간 기본값: 오늘 날짜 worklog의 가장 늦은 endTime, 없으면 현재 시각
  const defaultStartTime = getLatestEndTimeForDate(todayStr) || nowTime
  const initialKey = ctx.issueKey || ''
  const initialSummary = ctx.summary || ''
  // 이슈 키 상태 표시
  let keyStatusHtml = ''
  if (manualIssueCheck) {
    if (manualIssueCheck.status === 'checking') {
      keyStatusHtml = `<div class="input-hint">확인 중...</div>`
    } else if (manualIssueCheck.status === 'ok') {
      keyStatusHtml = `<div class="input-hint ok">✓ ${escapeHtml(manualIssueCheck.summary)}</div>`
    } else if (manualIssueCheck.status === 'error') {
      keyStatusHtml = `<div class="input-hint error">⚠ ${escapeHtml(manualIssueCheck.message)}</div>`
    }
  } else if (initialSummary) {
    keyStatusHtml = `<div class="input-hint ok">✓ ${escapeHtml(initialSummary)}</div>`
  }

  return `
    <div class="modal-overlay" id="manual-log-overlay">
      <div class="modal">
        <div class="modal-title">수동 작업 기록</div>
        <div class="modal-field">
          <label class="modal-label">이슈 키</label>
          <div class="autocomplete-wrapper">
            <input type="text" class="modal-input" id="manual-issue-key" placeholder="예: DKT-123 또는 키워드" value="${escapeHtml(initialKey)}" autocomplete="off" />
            <div class="autocomplete-dropdown" id="manual-key-dropdown"></div>
          </div>
          ${keyStatusHtml}
        </div>
        <div class="modal-field">
          <label class="modal-label">작업 날짜</label>
          <input type="date" class="modal-input" id="manual-date" value="${todayStr}" max="${todayStr}" />
        </div>
        <div class="modal-field">
          <label class="modal-label">시작 시간</label>
          <input type="time" class="modal-input" id="manual-start-time" value="${defaultStartTime}" data-autofilled="${defaultStartTime === nowTime ? '0' : '1'}" />
        </div>
        <div class="modal-field">
          <label class="modal-label">종료 시간</label>
          <div class="time-with-btn">
            <input type="time" class="modal-input" id="manual-end-time" value="${nowTime}" />
            <button type="button" class="btn btn-sm" id="manual-end-now">지금</button>
          </div>
        </div>
        <div class="modal-field">
          <label class="modal-label">소요 시간</label>
          <div class="duration-readout" id="manual-duration-readout">-</div>
        </div>
        <div class="modal-field">
          <label class="modal-label">작업 내용</label>
          <textarea class="modal-textarea" id="manual-comment" placeholder="작업 내용을 입력하세요..."></textarea>
        </div>
        <div class="modal-actions">
          <button class="btn" id="manual-log-cancel">취소</button>
          <button class="btn btn-primary" id="manual-log-submit">Jira에 기록</button>
        </div>
      </div>
    </div>
  `
}

// HTML 속성 이스케이프
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ========== 이슈 키 자동완성 ==========
// 로컬 풀(realIssues + searchResults + favorites)에서 쿼리 매칭 후보 생성
function findLocalIssueCandidates(query) {
  const q = query.trim().toUpperCase()
  if (!q) return []
  const pool = new Map()
  for (const i of getActiveIssues()) {
    if (i.key) pool.set(i.key, { key: i.key, summary: i.summary || '' })
  }
  for (const i of (searchResults || [])) {
    if (i.key && !pool.has(i.key)) pool.set(i.key, { key: i.key, summary: i.summary || '' })
  }
  for (const f of loadFavorites()) {
    if (f.issueKey && !pool.has(f.issueKey)) pool.set(f.issueKey, { key: f.issueKey, summary: f.summary || '' })
  }
  return [...pool.values()]
    .filter(i => i.key.toUpperCase().includes(q) || (i.summary || '').toUpperCase().includes(q))
    .slice(0, 15)
}

function renderManualKeyDropdown(candidates, loading = false) {
  const dropdown = document.getElementById('manual-key-dropdown')
  if (!dropdown) return
  if (candidates.length === 0 && !loading) {
    dropdown.style.display = 'none'
    dropdown.innerHTML = ''
    return
  }
  dropdown.style.display = 'block'
  const itemsHtml = candidates.map((c, idx) => `
    <div class="autocomplete-item ${idx === manualKeyActiveIdx ? 'active' : ''}" data-key="${c.key}" data-summary="${(c.summary || '').replace(/"/g, '&quot;')}" data-idx="${idx}">
      <span class="autocomplete-key">${c.key}</span>
      <span class="autocomplete-summary">${c.summary || ''}</span>
    </div>
  `).join('')
  let footerHtml = ''
  if (loading) {
    footerHtml = candidates.length === 0
      ? `<div class="autocomplete-loading"><span class="btn-spinner"></span><span>Jira에서 검색 중...</span></div>`
      : `<div class="autocomplete-footer"><span class="btn-spinner"></span><span>Jira에서 더 검색 중...</span></div>`
  }
  dropdown.innerHTML = itemsHtml + footerHtml
  dropdown.querySelectorAll('.autocomplete-item').forEach(el => {
    // mousedown은 blur보다 먼저 발생 → blur로 드롭다운 닫히기 전에 선택 처리
    el.addEventListener('mousedown', (e) => {
      e.preventDefault()
      selectManualKeyCandidate(el.dataset.key, el.dataset.summary || '')
    })
    el.addEventListener('mouseenter', () => {
      manualKeyActiveIdx = parseInt(el.dataset.idx)
      dropdown.querySelectorAll('.autocomplete-item').forEach((it, i) => {
        it.classList.toggle('active', i === manualKeyActiveIdx)
      })
    })
  })
}

function selectManualKeyCandidate(key, summary) {
  const input = document.getElementById('manual-issue-key')
  if (!input) return
  input.value = key
  manualIssueCheck = { status: 'ok', key, summary }
  renderManualKeyHint()
  const dropdown = document.getElementById('manual-key-dropdown')
  if (dropdown) { dropdown.style.display = 'none'; dropdown.innerHTML = '' }
  manualKeyActiveIdx = -1
}

function updateManualKeyDropdown() {
  const input = document.getElementById('manual-issue-key')
  if (!input) return
  const query = input.value
  if (!query.trim()) {
    renderManualKeyDropdown([])
    return
  }
  const localCandidates = findLocalIssueCandidates(query)
  manualKeyActiveIdx = -1

  // debounced API 검색으로 로컬에 없는 결과 보강
  clearTimeout(manualKeySearchTimer)
  const q = query.trim()
  if (q.length < 2) {
    renderManualKeyDropdown(localCandidates)
    return
  }
  // 즉시 로컬 후보 + 로딩 표시 (API 응답 대기 중)
  renderManualKeyDropdown(localCandidates, true)
  manualKeySearchTimer = setTimeout(async () => {
    try {
      const projectKeys = (realProjects && realProjects.length)
        ? realProjects.map(p => p.key)
        : ['DK', 'DKT', 'DD', 'RM']
      const apiResults = await searchIssuesByKey(q, projectKeys)
      const currentInput = document.getElementById('manual-issue-key')
      if (!currentInput || currentInput.value.trim() !== q) return
      const merged = [...localCandidates]
      for (const r of apiResults) {
        if (!merged.some(c => c.key === r.key)) {
          merged.push({ key: r.key, summary: r.summary })
        }
        if (merged.length >= 20) break
      }
      renderManualKeyDropdown(merged, false)
    } catch (err) {
      console.warn('자동완성 API 실패:', err)
      const currentInput = document.getElementById('manual-issue-key')
      if (!currentInput || currentInput.value.trim() !== q) return
      renderManualKeyDropdown(localCandidates, false)
    }
  }, 300)
}

// 이슈 키 힌트 영역만 직접 업데이트 (모달 입력값 유지 위해 전체 리렌더 회피)
function renderManualKeyHint() {
  const input = document.getElementById('manual-issue-key')
  if (!input) return
  const field = input.closest('.modal-field')
  if (!field) return
  const existing = field.querySelector('.input-hint')
  if (existing) existing.remove()
  if (!manualIssueCheck) return
  const hint = document.createElement('div')
  hint.className = 'input-hint'
  if (manualIssueCheck.status === 'checking') {
    hint.textContent = '확인 중...'
  } else if (manualIssueCheck.status === 'ok') {
    hint.classList.add('ok')
    hint.textContent = `✓ ${manualIssueCheck.summary || ''}`
  } else {
    hint.classList.add('error')
    hint.textContent = `⚠ ${manualIssueCheck.message || ''}`
  }
  field.appendChild(hint)
}

// 소요 시간 readout 업데이트 (수동 로그 모달)
function updateManualDurationReadout() {
  const startEl = document.getElementById('manual-start-time')
  const endEl = document.getElementById('manual-end-time')
  const readout = document.getElementById('manual-duration-readout')
  if (!startEl || !endEl || !readout) return
  const dur = computeDurationFromTimes(startEl.value, endEl.value)
  if (!dur.valid) {
    readout.textContent = dur.message || '-'
    readout.classList.add('error')
    return
  }
  readout.classList.remove('error')
  const main = formatMinutes(dur.actualMinutes)
  readout.textContent = dur.lunchMinutes > 0
    ? `${main} (점심 -${dur.lunchMinutes}분 차감)`
    : main
}

// 소요 시간 readout 업데이트 (수정 모달)
function updateEditDurationReadout() {
  const startEl = document.getElementById('edit-start-time')
  const endEl = document.getElementById('edit-end-time')
  const readout = document.getElementById('edit-duration-readout')
  if (!startEl || !endEl || !readout) return
  const dur = computeDurationFromTimes(startEl.value, endEl.value)
  if (!dur.valid) {
    readout.textContent = dur.message || '-'
    readout.classList.add('error')
    return
  }
  readout.classList.remove('error')
  const main = formatMinutes(dur.actualMinutes)
  readout.textContent = dur.lunchMinutes > 0
    ? `${main} (점심 -${dur.lunchMinutes}분 차감)`
    : main
}

// 시작/종료 시간(HH:MM)으로부터 점심시간 차감된 실제 소요(분) 계산
// 반환: { totalMinutes, lunchMinutes, actualMinutes, valid, message }
function computeDurationFromTimes(startTime, endTime) {
  if (!startTime || !endTime) return { valid: false, message: '시간을 입력해주세요.' }
  const [sh, sm] = startTime.split(':').map(Number)
  const [eh, em] = endTime.split(':').map(Number)
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  if (endMin <= startMin) return { valid: false, message: '종료 시간은 시작 시간보다 이후여야 합니다.' }
  const totalMinutes = endMin - startMin
  const lunchMinutes = Math.max(0, Math.min(endMin, LUNCH_END) - Math.max(startMin, LUNCH_START))
  const actualMinutes = Math.max(0, totalMinutes - lunchMinutes)
  if (actualMinutes <= 0) return { valid: false, message: '점심시간을 제외하면 실제 작업 시간이 없습니다.' }
  return { valid: true, totalMinutes, lunchMinutes, actualMinutes }
}

function invalidateWorklogMonth(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  worklogsLoadedMonths.delete(monthKey)
  for (const key of Object.keys(worklogsByDate)) {
    if (key.startsWith(monthKey)) delete worklogsByDate[key]
  }
  // localStorage 캐시도 제거
  const cache = loadWorklogCache()
  if (cache?.months?.[monthKey]) {
    delete cache.months[monthKey]
    try { localStorage.setItem(WORKLOG_CACHE_KEY, JSON.stringify(cache)) } catch {}
  }
  loadWorklogs(d.getFullYear(), d.getMonth())
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

  // 이슈 목록 새로고침
  const refreshIssuesBtn = document.getElementById('btn-refresh-issues')
  if (refreshIssuesBtn) {
    refreshIssuesBtn.addEventListener('click', () => refreshIssues())
  }

  // 작업 로그 새로고침
  const refreshWorklogsBtn = document.getElementById('btn-refresh-worklogs')
  if (refreshWorklogsBtn) {
    refreshWorklogsBtn.addEventListener('click', () => refreshWorklogs())
  }

  // 프로젝트 선택
  document.querySelectorAll('.project-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      currentProject = chip.dataset.project
      currentFilterTab = 'all'
      currentPage = 1
      // 검색 모드 해제
      searchQuery = ''
      searchResults = null
      render()
    })
  })

  // 메인 탭
  document.querySelectorAll('.main-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      currentMainTab = tab.dataset.mainTab
      if (tab.dataset.mainTab === 'logs' && isLoggedIn() && issuesLoaded) {
        loadWorklogs(calendarYear, calendarMonth)
      }
      if (tab.dataset.mainTab === 'summary') {
        ensureSummaryWorklogs()
      }
      render()
    })
  })

  // 필터 탭
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      currentFilterTab = tab.dataset.filter
      currentPage = 1
      // 검색 모드 해제
      searchQuery = ''
      searchResults = null
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

  // 현재 스프린트만 보기 토글
  const showSprintOnlyCheckbox = document.getElementById('show-sprint-only')
  if (showSprintOnlyCheckbox) {
    showSprintOnlyCheckbox.addEventListener('change', async (e) => {
      showSprintOnly = e.target.checked
      currentPage = 1
      if (showSprintOnly && activeSprintKeys === null) {
        sprintLoading = true
        render()
        try {
          const keys = await fetchActiveSprintIssueKeys()
          activeSprintKeys = new Set(keys)
        } catch (err) {
          console.error('스프린트 이슈 조회 실패:', err)
          activeSprintKeys = new Set()
          showToast('스프린트 이슈를 불러오지 못했습니다.', '⚠')
        }
        sprintLoading = false
      }
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

  // 연반차 토글
  document.querySelectorAll('[data-day-off]').forEach(btn => {
    btn.addEventListener('click', () => {
      const value = btn.dataset.dayOff
      setDayOff(logDate, value === 'none' ? null : value)
      render()
    })
  })

  // 달력 열기/닫기 토글
  const calendarToggleBtn = document.getElementById('btn-calendar-toggle')
  if (calendarToggleBtn) {
    calendarToggleBtn.addEventListener('click', () => {
      calendarOpen = !calendarOpen
      localStorage.setItem('log_calendar_open', calendarOpen ? '1' : '0')
      render()
    })
  }

  // 달력 년/월 직접 선택
  const calYearSelect = document.getElementById('cal-year')
  if (calYearSelect) {
    calYearSelect.addEventListener('change', (e) => {
      calendarYear = parseInt(e.target.value)
      // 미래 월 보정
      const now = new Date()
      if (calendarYear === now.getFullYear() && calendarMonth > now.getMonth()) {
        calendarMonth = now.getMonth()
      }
      if (isLoggedIn() && issuesLoaded) loadWorklogs(calendarYear, calendarMonth)
      render()
    })
  }

  const calMonthSelect = document.getElementById('cal-month')
  if (calMonthSelect) {
    calMonthSelect.addEventListener('change', (e) => {
      calendarMonth = parseInt(e.target.value)
      if (isLoggedIn() && issuesLoaded) loadWorklogs(calendarYear, calendarMonth)
      render()
    })
  }

  // 달력 월 네비게이션
  const calPrev = document.getElementById('cal-prev')
  if (calPrev) {
    calPrev.addEventListener('click', () => {
      calendarMonth--
      if (calendarMonth < 0) { calendarMonth = 11; calendarYear-- }
      if (isLoggedIn() && issuesLoaded) loadWorklogs(calendarYear, calendarMonth)
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
        if (isLoggedIn() && issuesLoaded) loadWorklogs(calendarYear, calendarMonth)
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
      if (isLoggedIn() && issuesLoaded) loadWorklogs(calendarYear, calendarMonth)
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
      const d = new Date(logDate + 'T00:00:00')
      if (isLoggedIn() && issuesLoaded) loadWorklogs(d.getFullYear(), d.getMonth())
      render()
    })
  }

  const logNext = document.getElementById('log-next')
  if (logNext && !logNext.disabled) {
    logNext.addEventListener('click', () => {
      const next = shiftDate(logDate, 1)
      if (next <= toDateString(new Date())) {
        logDate = next
        const d = new Date(logDate + 'T00:00:00')
        if (isLoggedIn() && issuesLoaded) loadWorklogs(d.getFullYear(), d.getMonth())
        render()
      }
    })
  }

  const logToday = document.getElementById('log-today')
  if (logToday) {
    logToday.addEventListener('click', () => {
      logDate = toDateString(new Date())
      const d = new Date(logDate + 'T00:00:00')
      if (isLoggedIn() && issuesLoaded) loadWorklogs(d.getFullYear(), d.getMonth())
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

  // 이슈 행 우클릭 → 컨텍스트 메뉴
  document.querySelectorAll('.issue-row[data-issue-key]').forEach(row => {
    row.addEventListener('contextmenu', (e) => {
      const key = row.dataset.issueKey
      const summary = row.dataset.issueSummary
      if (key) showContextMenu(e, key, summary)
    })
  })

  // 작업 로그 상세 행 우클릭 → 컨텍스트 메뉴 (이슈 행과 동일)
  document.querySelectorAll('.log-row[data-issue-key]').forEach(row => {
    row.addEventListener('contextmenu', (e) => {
      const key = row.dataset.issueKey
      const summary = row.dataset.issueSummary
      if (key) showContextMenu(e, key, summary)
    })
  })

  // 즐겨찾기 별표 토글
  document.querySelectorAll('[data-action="toggle-favorite"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const key = btn.dataset.key
      const pool = [...getActiveIssues(), ...(searchResults || [])]
      const issue = pool.find(i => i.key === key)
      toggleFavorite(key, issue?.summary || '')
      render()
    })
  })

  // 플로팅 패널 펼치기/접기
  const favToggle = document.getElementById('favorites-toggle')
  if (favToggle) {
    favToggle.addEventListener('click', () => {
      favoritesPanelCollapsed = !favoritesPanelCollapsed
      localStorage.setItem('favorites_collapsed', favoritesPanelCollapsed ? '1' : '0')
      render()
    })
  }

  // 즐겨찾기 패널의 시작 버튼
  document.querySelectorAll('[data-action="fav-start"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const key = btn.dataset.key
      const summary = btn.dataset.summary || ''
      addSession(key, summary)
      render()
    })
  })

  // 즐겨찾기 해제 (패널 내부)
  document.querySelectorAll('[data-action="fav-remove"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const key = btn.dataset.key
      toggleFavorite(key, '')
      render()
    })
  })

  // 즐겨찾기 항목 우클릭 → 컨텍스트 메뉴
  document.querySelectorAll('.favorite-item[data-issue-key]').forEach(row => {
    row.addEventListener('contextmenu', (e) => {
      const key = row.dataset.issueKey
      const summary = row.dataset.issueSummary
      if (key) showContextMenu(e, key, summary)
    })
  })

  // 이슈 행 호버 시 표시되는 '수동 기록' 버튼
  document.querySelectorAll('[data-action="manual-log"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const key = btn.dataset.key
      const pool = [...getActiveIssues(), ...(searchResults || [])]
      const issue = pool.find(i => i.key === key)
      if (!issue) return
      showManualLog = { issueKey: key, summary: issue.summary }
      manualIssueCheck = { status: 'ok', key, summary: issue.summary }
      render()
    })
  })

  // 이슈 목록에서 작업 시작
  document.querySelectorAll('[data-action="start"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const key = btn.dataset.key
      // 이슈 목록 또는 검색 결과에서 찾기
      const allIssues = [...getActiveIssues(), ...(searchResults || [])]
      const issue = allIssues.find(i => i.key === key)
      if (issue) {
        addSession(key, issue.summary)
        render()
      }
    })
  })

  // 세션 시작 시간을 직전 로그 종료 시간으로 조정
  document.querySelectorAll('[data-action="adjust-session-start"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (btn.disabled) return
      const key = btn.dataset.key
      const sessions = loadSessions()
      const s = sessions.find(x => x.issueKey === key)
      if (!s || !s.segments.length) return
      const firstSeg = s.segments[0]
      const startDate = firstSeg.start
      const dateStr = toDateString(startDate)

      const originalLabel = btn.textContent
      btn.disabled = true
      btn.textContent = '불러오는 중...'
      try {
        await ensureMonthWorklogsLoaded(startDate.getFullYear(), startDate.getMonth())
      } catch (err) {
        console.error('작업 로그 로드 실패:', err)
        showToast('작업 로그를 불러오지 못했습니다.', '⚠')
        btn.disabled = false
        btn.textContent = originalLabel
        return
      }
      btn.disabled = false
      btn.textContent = originalLabel

      const logs = worklogsByDate[dateStr] || []
      if (!logs.length) {
        showToast('해당 날짜에 기록된 작업 로그가 없습니다.', 'ℹ')
        return
      }
      const latestEnd = logs.reduce((max, l) => (l.endTime > max ? l.endTime : max), '00:00')
      const [h, m] = latestEnd.split(':').map(Number)
      const newStart = new Date(startDate)
      newStart.setHours(h, m, 0, 0)

      if (newStart.getTime() >= firstSeg.start.getTime()) {
        showToast('직전 종료 시간이 현재 시작 시간보다 늦어 조정할 수 없습니다.', 'ℹ')
        return
      }
      firstSeg.start = newStart
      saveSessions(sessions)
      showToast(`시작 시간을 ${latestEnd}(으)로 조정했습니다.`, '✓')
      render()
    })
  })

  // 세션 중단
  document.querySelectorAll('[data-action="pause"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      pauseSession(btn.dataset.key)
      render()
    })
  })

  // 세션 재개
  document.querySelectorAll('[data-action="resume"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      resumeSession(btn.dataset.key)
      render()
    })
  })

  // 작업 종료 버튼 → 종료 모달
  document.querySelectorAll('[data-action="finish"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      showModal = btn.dataset.key
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
      if (e.target === overlay) { showModal = null; render() }
    })
  }

  const modalCancel = document.getElementById('modal-cancel')
  if (modalCancel) {
    modalCancel.addEventListener('click', () => { showModal = null; render() })
  }

  const modalSubmit = document.getElementById('modal-submit')
  if (modalSubmit) {
    modalSubmit.addEventListener('click', async () => {
      const sessions = loadSessions()
      const session = sessions.find(s => s.issueKey === showModal)
      if (!session) return

      const details = getSegmentDetails(session)
      const comment = document.getElementById('finish-comment')?.value || ''

      // 타임존 오프셋
      const offset = new Date().getTimezoneOffset()
      const sign = offset <= 0 ? '+' : '-'
      const absOff = Math.abs(offset)
      const tzStr = `${sign}${String(Math.floor(absOff / 60)).padStart(2, '0')}:${String(absOff % 60).padStart(2, '0')}`

      try {
        // 구간별로 worklog 생성
        for (const seg of details) {
          if (seg.actualMinutes <= 0) continue
          const started = `${toDateString(seg.start)}T${String(seg.start.getHours()).padStart(2, '0')}:${String(seg.start.getMinutes()).padStart(2, '0')}:00.000${tzStr}`
          await createWorklog(session.issueKey, {
            started,
            timeSpentSeconds: seg.actualMinutes * 60,
            comment,
          })
        }
        removeSession(session.issueKey)
        showModal = null
        // 관련된 모든 월 캐시 무효화
        const months = new Set(details.map(d => `${d.start.getFullYear()}-${d.start.getMonth()}`))
        for (const m of months) {
          const [y, mo] = m.split('-')
          invalidateWorklogMonth(toDateString(details[0].start))
        }
        render()
      } catch (e) {
        console.error('Jira worklog 기록 실패:', e)
        alert('Jira에 worklog 기록에 실패했습니다.')
      }
    })
  }

  // 취소 컨펌 모달
  const cancelOverlay = document.getElementById('cancel-overlay')
  if (cancelOverlay) {
    cancelOverlay.addEventListener('click', (e) => {
      if (e.target === cancelOverlay) { showCancelConfirm = null; render() }
    })
  }

  const cancelNo = document.getElementById('cancel-confirm-no')
  if (cancelNo) {
    cancelNo.addEventListener('click', () => { showCancelConfirm = null; render() })
  }

  const cancelYes = document.getElementById('cancel-confirm-yes')
  if (cancelYes) {
    cancelYes.addEventListener('click', () => {
      removeSession(showCancelConfirm)
      showCancelConfirm = null
      render()
    })
  }

  // 수동 기록 버튼
  const manualLogBtn = document.getElementById('btn-manual-log')
  if (manualLogBtn) {
    manualLogBtn.addEventListener('click', () => {
      showManualLog = {}
      manualIssueCheck = null
      render()
    })
  }

  // 수동 기록 모달
  const manualOverlay = document.getElementById('manual-log-overlay')
  if (manualOverlay) {
    manualOverlay.addEventListener('click', (e) => {
      if (e.target === manualOverlay) { showManualLog = null; manualIssueCheck = null; render() }
    })
  }

  const manualCancel = document.getElementById('manual-log-cancel')
  if (manualCancel) {
    manualCancel.addEventListener('click', () => { showManualLog = null; manualIssueCheck = null; render() })
  }

  // 이슈 키 입력: 자동완성 드롭다운
  const manualIssueInput = document.getElementById('manual-issue-key')
  if (manualIssueInput) {
    manualIssueInput.addEventListener('input', () => {
      manualIssueCheck = null
      renderManualKeyHint()
      updateManualKeyDropdown()
    })
    manualIssueInput.addEventListener('focus', () => {
      if (manualIssueInput.value.trim()) updateManualKeyDropdown()
    })
    // 키보드 네비게이션
    manualIssueInput.addEventListener('keydown', (e) => {
      const dropdown = document.getElementById('manual-key-dropdown')
      if (!dropdown || dropdown.style.display === 'none') return
      const items = dropdown.querySelectorAll('.autocomplete-item')
      if (items.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        manualKeyActiveIdx = (manualKeyActiveIdx + 1) % items.length
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        manualKeyActiveIdx = (manualKeyActiveIdx - 1 + items.length) % items.length
      } else if (e.key === 'Enter') {
        if (manualKeyActiveIdx >= 0) {
          e.preventDefault()
          const el = items[manualKeyActiveIdx]
          selectManualKeyCandidate(el.dataset.key, el.dataset.summary || '')
          return
        }
      } else if (e.key === 'Escape') {
        manualKeyActiveIdx = -1
        dropdown.style.display = 'none'
        dropdown.innerHTML = ''
        return
      } else {
        return
      }
      items.forEach((el, i) => el.classList.toggle('active', i === manualKeyActiveIdx))
      if (manualKeyActiveIdx >= 0) items[manualKeyActiveIdx].scrollIntoView({ block: 'nearest' })
    })
  }

  // 이슈 키 입력: blur 시 유효성 검사 (폼 초기화 방지 위해 render() 대신 힌트 DOM 직접 업데이트)
  if (manualIssueInput) {
    manualIssueInput.addEventListener('blur', async () => {
      // blur 후 드롭다운 닫기 (mousedown 선택이 먼저 처리되도록 지연)
      setTimeout(() => {
        const dd = document.getElementById('manual-key-dropdown')
        if (dd) { dd.style.display = 'none'; dd.innerHTML = '' }
      }, 150)
      const key = manualIssueInput.value.trim().toUpperCase()
      manualIssueInput.value = key
      if (!key) { manualIssueCheck = null; renderManualKeyHint(); return }
      if (!isValidIssueKeyFormat(key)) {
        manualIssueCheck = { status: 'error', key, message: '올바른 형식이 아닙니다. 예: DKT-123' }
        renderManualKeyHint()
        return
      }
      const local = findLoadedIssue(key)
      if (local) {
        manualIssueCheck = { status: 'ok', key, summary: local.summary }
        renderManualKeyHint()
        return
      }
      manualIssueCheck = { status: 'checking', key }
      renderManualKeyHint()
      try {
        const meta = await fetchIssueMeta(key)
        if (meta) {
          manualIssueCheck = { status: 'ok', key: meta.key, summary: meta.summary }
        } else {
          manualIssueCheck = { status: 'error', key, message: '이슈를 찾을 수 없습니다.' }
        }
      } catch {
        manualIssueCheck = { status: 'error', key, message: '이슈를 찾을 수 없거나 접근 권한이 없습니다.' }
      }
      renderManualKeyHint()
    })
  }

  // 시작 시간 자동 채우기: 선택된 날짜의 마지막 worklog endTime으로 설정
  // (사용자가 수동으로 수정하면 autofill 플래그가 꺼져 다음 자동 주입을 건드리지 않음)
  const manualStartInputEl = document.getElementById('manual-start-time')
  if (manualStartInputEl) {
    manualStartInputEl.addEventListener('input', () => {
      manualStartInputEl.dataset.autofilled = '0'
    })
  }

  async function autofillManualStartTime() {
    const dateInput = document.getElementById('manual-date')
    const startInput = document.getElementById('manual-start-time')
    if (!dateInput || !startInput) return
    const date = dateInput.value
    if (!date) return
    const d = new Date(date + 'T00:00:00')
    try {
      await ensureMonthWorklogsLoaded(d.getFullYear(), d.getMonth())
    } catch (e) {
      console.warn('작업 로그 로드 실패:', e)
      return
    }
    const latestEnd = getLatestEndTimeForDate(date)
    if (!latestEnd) return
    // 사용자가 입력란을 직접 건드렸다면 덮어쓰지 않음
    if (startInput.dataset.autofilled === '0') return
    startInput.value = latestEnd
    startInput.dataset.autofilled = '1'
    updateManualDurationReadout()
  }

  // 모달 열린 직후: 아직 worklog가 로드되지 않았을 수 있으므로 비동기로 확인
  autofillManualStartTime()

  // 날짜 변경 시 시작 시간 재계산 (사용자 수정 전인 경우에만)
  const manualDateInput = document.getElementById('manual-date')
  if (manualDateInput) {
    manualDateInput.addEventListener('change', () => {
      const startInput = document.getElementById('manual-start-time')
      if (startInput) startInput.dataset.autofilled = '1'  // 자동 채움 허용 상태로 복귀
      autofillManualStartTime()
    })
  }

  // '지금' 버튼: 종료 시간을 현재 시각으로
  const manualEndNow = document.getElementById('manual-end-now')
  if (manualEndNow) {
    manualEndNow.addEventListener('click', () => {
      const now = new Date()
      const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const endInput = document.getElementById('manual-end-time')
      if (endInput) {
        endInput.value = nowTime
        updateManualDurationReadout()
      }
    })
  }

  // 시작/종료 시간 변경 → 소요 시간 실시간 계산
  const manualStartInput = document.getElementById('manual-start-time')
  const manualEndInput = document.getElementById('manual-end-time')
  if (manualStartInput) manualStartInput.addEventListener('input', updateManualDurationReadout)
  if (manualEndInput) manualEndInput.addEventListener('input', updateManualDurationReadout)
  if (manualStartInput || manualEndInput) updateManualDurationReadout()

  const manualSubmit = document.getElementById('manual-log-submit')
  const manualCancelBtn = document.getElementById('manual-log-cancel')
  if (manualSubmit) {
    manualSubmit.addEventListener('click', async () => {
      if (manualSubmit.disabled) return
      const issueKey = document.getElementById('manual-issue-key').value.trim().toUpperCase()
      const date = document.getElementById('manual-date').value
      const startTime = document.getElementById('manual-start-time').value
      const endTime = document.getElementById('manual-end-time').value
      const comment = document.getElementById('manual-comment').value

      if (!issueKey) { alert('이슈 키를 입력해주세요.'); return }
      if (!isValidIssueKeyFormat(issueKey)) { alert('이슈 키 형식이 올바르지 않습니다. 예: DKT-123'); return }
      if (manualIssueCheck?.status === 'error') { alert('이슈 키를 확인해주세요.'); return }
      if (!date) { alert('날짜를 입력해주세요.'); return }

      const dur = computeDurationFromTimes(startTime, endTime)
      if (!dur.valid) { alert(dur.message); return }

      const offset = new Date().getTimezoneOffset()
      const sign = offset <= 0 ? '+' : '-'
      const absOff = Math.abs(offset)
      const tzStr = `${sign}${String(Math.floor(absOff / 60)).padStart(2, '0')}:${String(absOff % 60).padStart(2, '0')}`
      const started = `${date}T${startTime}:00.000${tzStr}`

      // 제출 중: 버튼을 스피너로 전환 + 중복 클릭 방지
      const originalLabel = manualSubmit.innerHTML
      manualSubmit.disabled = true
      manualSubmit.classList.add('is-loading')
      manualSubmit.innerHTML = '<span class="btn-spinner"></span>'
      if (manualCancelBtn) manualCancelBtn.disabled = true

      try {
        await createWorklog(issueKey, { started, timeSpentSeconds: dur.actualMinutes * 60, comment })
        showManualLog = null
        manualIssueCheck = null
        invalidateWorklogMonth(date)
        render()
      } catch (e) {
        console.error('수동 작업 기록 실패:', e)
        alert('작업 기록에 실패했습니다. 이슈 키를 확인해주세요.')
        manualSubmit.disabled = false
        manualSubmit.classList.remove('is-loading')
        manualSubmit.innerHTML = originalLabel
        if (manualCancelBtn) manualCancelBtn.disabled = false
      }
    })
  }

  // 요약 탭 주차 네비게이션
  const summaryPrev = document.getElementById('summary-prev')
  if (summaryPrev) {
    summaryPrev.addEventListener('click', () => {
      summaryWeekOffset--
      ensureSummaryWorklogs()
      render()
    })
  }

  const summaryNext = document.getElementById('summary-next')
  if (summaryNext && !summaryNext.disabled) {
    summaryNext.addEventListener('click', () => {
      if (summaryWeekOffset < 0) {
        summaryWeekOffset++
        ensureSummaryWorklogs()
        render()
      }
    })
  }

  const summaryThisWeek = document.getElementById('summary-this-week')
  if (summaryThisWeek) {
    summaryThisWeek.addEventListener('click', () => {
      summaryWeekOffset = 0
      ensureSummaryWorklogs()
      render()
    })
  }

  // 작업 로그 수정 버튼
  document.querySelectorAll('[data-action="edit-log"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const idx = parseInt(btn.dataset.idx)
      const logs = getActiveLogs(logDate)
      const log = logs[idx]
      if (!log?.worklogId) return
      editingWorklog = {
        worklogId: log.worklogId,
        issueKey: log.issueKey,
        summary: log.summary,
        startTime: log.startTime,
        durationHours: Math.floor(log.durationMinutes / 60),
        durationMins: log.durationMinutes % 60,
        comment: log.comment || '',
        date: logDate,
      }
      render()
    })
  })

  // 작업 로그 삭제 버튼
  document.querySelectorAll('[data-action="delete-log"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const idx = parseInt(btn.dataset.idx)
      const logs = getActiveLogs(logDate)
      const log = logs[idx]
      if (!log?.worklogId) return
      deletingWorklog = {
        worklogId: log.worklogId,
        issueKey: log.issueKey,
        summary: log.summary,
      }
      render()
    })
  })

  // 수정 모달
  const editOverlay = document.getElementById('edit-worklog-overlay')
  if (editOverlay) {
    editOverlay.addEventListener('click', (e) => {
      if (e.target === editOverlay) { editingWorklog = null; render() }
    })
  }

  const editCancel = document.getElementById('edit-worklog-cancel')
  if (editCancel) {
    editCancel.addEventListener('click', () => { editingWorklog = null; render() })
  }

  // 수정 모달: '지금' 버튼 + 실시간 계산
  const editEndNow = document.getElementById('edit-end-now')
  if (editEndNow) {
    editEndNow.addEventListener('click', () => {
      const now = new Date()
      const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const endInput = document.getElementById('edit-end-time')
      if (endInput) {
        endInput.value = nowTime
        updateEditDurationReadout()
      }
    })
  }
  const editStartInput = document.getElementById('edit-start-time')
  const editEndInput = document.getElementById('edit-end-time')
  if (editStartInput) editStartInput.addEventListener('input', updateEditDurationReadout)
  if (editEndInput) editEndInput.addEventListener('input', updateEditDurationReadout)
  if (editStartInput || editEndInput) updateEditDurationReadout()

  const editSubmit = document.getElementById('edit-worklog-submit')
  const editCancelBtn = document.getElementById('edit-worklog-cancel')
  if (editSubmit) {
    editSubmit.addEventListener('click', async () => {
      if (editSubmit.disabled) return
      const startTime = document.getElementById('edit-start-time').value
      const endTime = document.getElementById('edit-end-time').value
      const comment = document.getElementById('edit-comment').value

      const dur = computeDurationFromTimes(startTime, endTime)
      if (!dur.valid) { alert(dur.message); return }

      const offset = new Date().getTimezoneOffset()
      const sign = offset <= 0 ? '+' : '-'
      const absOff = Math.abs(offset)
      const tzStr = `${sign}${String(Math.floor(absOff / 60)).padStart(2, '0')}:${String(absOff % 60).padStart(2, '0')}`
      const started = `${editingWorklog.date}T${startTime}:00.000${tzStr}`

      const originalLabel = editSubmit.innerHTML
      editSubmit.disabled = true
      editSubmit.classList.add('is-loading')
      editSubmit.innerHTML = '<span class="btn-spinner"></span>'
      if (editCancelBtn) editCancelBtn.disabled = true

      try {
        await updateWorklog(editingWorklog.issueKey, editingWorklog.worklogId, {
          started,
          timeSpentSeconds: dur.actualMinutes * 60,
          comment,
        })
        const savedDate = editingWorklog.date
        editingWorklog = null
        invalidateWorklogMonth(savedDate)
      } catch (e) {
        console.error('작업 로그 수정 실패:', e)
        alert('작업 로그 수정에 실패했습니다.')
        editSubmit.disabled = false
        editSubmit.classList.remove('is-loading')
        editSubmit.innerHTML = originalLabel
        if (editCancelBtn) editCancelBtn.disabled = false
      }
    })
  }

  // 삭제 확인 모달
  const deleteOverlay = document.getElementById('delete-worklog-overlay')
  if (deleteOverlay) {
    deleteOverlay.addEventListener('click', (e) => {
      if (e.target === deleteOverlay) { deletingWorklog = null; render() }
    })
  }

  const deleteNo = document.getElementById('delete-worklog-no')
  if (deleteNo) {
    deleteNo.addEventListener('click', () => { deletingWorklog = null; render() })
  }

  const deleteYes = document.getElementById('delete-worklog-yes')
  if (deleteYes) {
    deleteYes.addEventListener('click', async () => {
      try {
        await deleteWorklog(deletingWorklog.issueKey, deletingWorklog.worklogId)
        deletingWorklog = null
        invalidateWorklogMonth(logDate)
      } catch (e) {
        console.error('작업 로그 삭제 실패:', e)
        alert('작업 로그 삭제에 실패했습니다.')
      }
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
      if (el.dataset.status === 'active' && el.dataset.segments) {
        try {
          const segments = JSON.parse(el.dataset.segments)
          let totalMs = 0
          for (const seg of segments) {
            const end = seg.end || Date.now()
            totalMs += end - seg.start
          }
          const totalMinutes = Math.floor(totalMs / 60000)
          el.textContent = formatMinutes(totalMinutes)
        } catch {}
      }
    })
  }, 1000)
}

// ========== 데이터 로드 ==========
async function loadIssues() {
  if (issuesLoading) return

  const userName = getSavedUser()?.displayName || ''

  // 1) 캐시가 있으면 즉시 표시
  const cached = loadIssuesCache()
  if (cached) {
    realIssues = cached.issues
    realProjects = cached.projects
    issuesLoaded = true
    render()
  }

  // 2) API에서 최신 데이터 가져오기
  if (!cached) {
    issuesLoading = true
    render()
  } else {
    showToast(`${userName}님의 이슈 목록을 업데이트합니다.`, '🔄')
  }

  try {
    const [freshIssues, freshProjects] = await Promise.all([
      fetchMyIssues(),
      fetchProjects(),
    ])

    // 변경 감지
    const oldCount = cached?.issues?.length || 0
    const newCount = freshIssues.length
    const hasChanged = !cached || JSON.stringify(freshIssues.map(i => i.key).sort()) !== JSON.stringify((cached.issues || []).map(i => i.key).sort())

    realIssues = freshIssues
    realProjects = freshProjects
    issuesLoaded = true
    saveIssuesCache(freshIssues, freshProjects)

    if (cached) {
      if (hasChanged) {
        showToast(`이슈 목록이 업데이트되었습니다.`, '✓')
      } else {
        showToast('이미 최신 이슈 목록입니다.', '✓')
      }
    }
  } catch (e) {
    console.error('이슈 로드 실패:', e)
  }

  issuesLoading = false
  render()

  // 로그 탭이 활성 상태이면 worklog도 로드
  if (issuesLoaded && currentMainTab === 'logs') {
    loadWorklogs(calendarYear, calendarMonth)
  }
}

async function loadWorklogs(year, month) {
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`
  if (worklogsLoadedMonths.has(monthKey) || worklogsLoading) return

  const userName = getSavedUser()?.displayName || ''

  // 1) 캐시가 있으면 즉시 표시 (stale)
  const cached = getCachedMonth(monthKey)
  if (cached) {
    mergeLogs(cached)
    render()
  }

  // 2) API에서 최신 데이터 가져오기 (revalidate)
  if (!cached) {
    worklogsLoading = true
    render()
  } else {
    showToast(`${userName}님의 작업 기록을 업데이트합니다.`, '🔄')
  }

  try {
    const startDate = `${year}-${String(month + 1).padStart(2, '0')}-01`
    const lastDay = new Date(year, month + 1, 0).getDate()
    const endDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    const freshLogs = await fetchMyWorklogs(startDate, endDate)

    // 변경 감지
    const oldEntryCount = cached ? Object.values(cached).flat().length : 0
    const newEntryCount = Object.values(freshLogs).flat().length
    const hasChanged = !cached || JSON.stringify(cached) !== JSON.stringify(freshLogs)

    // 해당 월의 기존 데이터 제거 후 새 데이터 병합
    for (const key of Object.keys(worklogsByDate)) {
      if (key.startsWith(monthKey)) delete worklogsByDate[key]
    }
    mergeLogs(freshLogs)
    worklogsLoadedMonths.add(monthKey)

    // 캐시 갱신
    saveWorklogCache(monthKey, freshLogs)

    if (cached) {
      if (hasChanged) {
        showToast('작업 기록이 업데이트되었습니다.', '✓')
      } else {
        showToast('이미 최신 작업 기록입니다.', '✓')
      }
    }
  } catch (e) {
    console.error('작업 로그 로드 실패:', e)
  }

  worklogsLoading = false
  render()
}

// 특정 월 worklog를 render() 없이 조용히 로드 (모달 폼 유지용)
// 1) 메모리에 이미 있으면 그대로 사용
// 2) localStorage 캐시에 있으면 즉시 병합 후 반환 (네트워크 호출 X)
// 3) 그 외에만 API 호출
async function ensureMonthWorklogsLoaded(year, month) {
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`
  if (worklogsLoadedMonths.has(monthKey)) return

  const cached = getCachedMonth(monthKey)
  if (cached) {
    mergeLogs(cached)
    worklogsLoadedMonths.add(monthKey)
    return
  }

  const startDate = `${year}-${String(month + 1).padStart(2, '0')}-01`
  const lastDay = new Date(year, month + 1, 0).getDate()
  const endDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  const fresh = await fetchMyWorklogs(startDate, endDate)
  for (const key of Object.keys(worklogsByDate)) {
    if (key.startsWith(monthKey)) delete worklogsByDate[key]
  }
  mergeLogs(fresh)
  worklogsLoadedMonths.add(monthKey)
  saveWorklogCache(monthKey, fresh)
}

// 이슈 목록 강제 새로고침
async function refreshIssues() {
  if (issuesLoading) return
  const userName = getSavedUser()?.displayName || ''
  issuesLoading = true
  // 스프린트 캐시 초기화 (다음에 필요해지면 재조회)
  activeSprintKeys = null
  render()
  showToast(`${userName}님의 이슈 목록을 업데이트합니다.`, '🔄')
  try {
    const promises = [fetchMyIssues(), fetchProjects()]
    if (showSprintOnly) promises.push(fetchActiveSprintIssueKeys())
    const [freshIssues, freshProjects, sprintKeys] = await Promise.all(promises)
    if (showSprintOnly) activeSprintKeys = new Set(sprintKeys || [])
    const oldKeys = JSON.stringify(realIssues.map(i => i.key).sort())
    const newKeys = JSON.stringify(freshIssues.map(i => i.key).sort())
    realIssues = freshIssues
    realProjects = freshProjects
    issuesLoaded = true
    saveIssuesCache(freshIssues, freshProjects)
    if (oldKeys !== newKeys) {
      showToast('이슈 목록이 업데이트되었습니다.', '✓')
    } else {
      showToast('이미 최신 이슈 목록입니다.', '✓')
    }
  } catch (e) {
    console.error('이슈 새로고침 실패:', e)
    showToast('이슈 새로고침에 실패했습니다.', '⚠')
  }
  issuesLoading = false
  render()
}

// 현재 월 작업 로그 강제 새로고침
async function refreshWorklogs() {
  if (worklogsLoading) return
  const userName = getSavedUser()?.displayName || ''
  const year = calendarYear
  const month = calendarMonth
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`
  worklogsLoadedMonths.delete(monthKey)
  worklogsLoading = true
  render()
  showToast(`${userName}님의 작업 기록을 업데이트합니다.`, '🔄')
  try {
    const startDate = `${year}-${String(month + 1).padStart(2, '0')}-01`
    const lastDay = new Date(year, month + 1, 0).getDate()
    const endDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    const freshLogs = await fetchMyWorklogs(startDate, endDate)
    const oldSnapshot = JSON.stringify(
      Object.keys(worklogsByDate)
        .filter(k => k.startsWith(monthKey))
        .reduce((acc, k) => { acc[k] = worklogsByDate[k]; return acc }, {})
    )
    for (const key of Object.keys(worklogsByDate)) {
      if (key.startsWith(monthKey)) delete worklogsByDate[key]
    }
    mergeLogs(freshLogs)
    worklogsLoadedMonths.add(monthKey)
    saveWorklogCache(monthKey, freshLogs)
    if (oldSnapshot !== JSON.stringify(freshLogs)) {
      showToast('작업 기록이 업데이트되었습니다.', '✓')
    } else {
      showToast('이미 최신 작업 기록입니다.', '✓')
    }
  } catch (e) {
    console.error('작업 로그 새로고침 실패:', e)
    showToast('작업 로그 새로고침에 실패했습니다.', '⚠')
  }
  worklogsLoading = false
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
