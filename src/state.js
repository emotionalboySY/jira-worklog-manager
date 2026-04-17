// 전역 상태 + 상수 모음. 다른 모듈은 `state` 객체를 import하여 읽고 쓴다.

// ========== 상수 ==========

// 로그인 직후 realProjects 로드 전까지 사용할 fallback 목록
export const PROJECTS = [
  { key: 'ALL', name: '전체' },
  { key: 'DK', name: '매일국어' },
  { key: 'DKT', name: '매일국어T' },
  { key: 'RM', name: '리딩수학과학' },
  { key: 'DD', name: '독도' },
]

export const LUNCH_START = 12 * 60 // 12:00 (분 단위)
export const LUNCH_END = 13 * 60   // 13:00 (분 단위)

export const ISSUE_TYPES = {
  task:      { icon: '✓', label: '작업' },
  story:     { icon: '★', label: '스토리' },
  epic:      { icon: '⚡', label: '에픽' },
  hotfix:    { icon: '🔥', label: '핫픽스' },
  operation: { icon: '⚙', label: '운영' },
  bug:       { icon: '✕', label: '버그' },
}

export const ISSUE_STATUSES = {
  todo:        { label: '할 일', css: 'todo' },
  inProgress:  { label: '진행 중', css: 'in-progress' },
  inReview:    { label: '검토 중', css: 'in-review' },
  done:        { label: '완료', css: 'done' },
}

// 정렬 순서 (낮을수록 위에 표시)
export const STATUS_ORDER = {
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
export const PROJECT_ORDER = { 'DK': 0, 'DKT': 1, 'DD': 2, 'RM': 3 }

// 프로젝트별 색상 (배지/왼쪽 바). 미매핑 프로젝트는 기본 accent 색상 폴백
export const PROJECT_COLORS = {
  DK:  { fg: '#60a5fa', bg: 'rgba(59, 130, 246, 0.14)' },   // 파랑
  DKT: { fg: '#34d399', bg: 'rgba(16, 185, 129, 0.14)' },   // 초록
  DD:  { fg: '#fb923c', bg: 'rgba(249, 115, 22, 0.14)' },   // 주황
  RM:  { fg: '#c084fc', bg: 'rgba(168, 85, 247, 0.14)' },   // 보라
}
export const CLOSED_CATEGORY = 'done'  // Jira statusCategory key

// localStorage 키
export const SESSIONS_KEY = 'work_sessions'
export const DAY_OFFS_KEY = 'day_offs'
export const FAVORITES_KEY = 'favorite_issues'
export const ISSUES_CACHE_KEY = 'issues_cache'
export const WORKLOG_CACHE_KEY = 'worklog_cache'
export const WORKLOG_CACHE_MAX_MONTHS = 3

// 이슈 키 형식 검사 (예: DKT-123)
export const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/

// ========== 초기값 계산 헬퍼 ==========
function initialLogDate() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ========== 전역 state ==========
export const state = {
  // ----- 데이터 -----
  realIssues: [],       // Jira에서 가져온 이슈 목록
  realProjects: [],     // Jira에서 가져온 프로젝트 목록
  issuesLoading: false,
  issuesLoaded: false,

  // 작업 로그 데이터
  worklogsByDate: {},           // { 'YYYY-MM-DD': [...] }
  worklogsLoading: false,
  worklogsLoadedMonths: new Set(),  // API 로드 완료된 월 ("YYYY-MM" 형식)

  // ----- UI 상태 -----
  currentMainTab: 'issues',
  currentFilterTab: 'all',
  currentProject: 'ALL',
  currentPage: 1,
  showClosedIssues: false,
  showSprintOnly: false,
  activeSprintKeys: null,  // Set<string> | null (null=아직 로드 안됨)
  sprintLoading: false,
  pageSize: 20,
  searchQuery: '',
  searchResults: null, // null=검색모드 아님, []=검색 결과
  searchLoading: false,

  logDate: initialLogDate(), // 선택된 날짜
  calendarOpen: (localStorage.getItem('log_calendar_open') !== '0'), // 기본 열림
  calendarYear: new Date().getFullYear(),
  calendarMonth: new Date().getMonth(), // 0-indexed
  summaryWeekOffset: 0,   // 0=이번 주, -1=지난 주, ...

  // ----- 모달 -----
  showModal: null,             // 종료 모달 대상 issueKey
  showCancelConfirm: null, // 취소 확인 대상 issueKey
  editingWorklog: null,    // 수정 중인 워크로그
  deletingWorklog: null,   // 삭제 확인 중인 워크로그
  showManualLog: null,     // 수동 작업 기록 모달 state: null | { issueKey, summary }
  manualIssueCheck: null,  // 이슈 키 검증 결과: null | { status: 'checking'|'ok'|'error', key, summary, message }
  manualKeySearchTimer: null,  // 이슈 키 자동완성 API debounce 타이머
  manualKeySearchController: null,  // 자동완성 in-flight 요청 취소용
  manualKeyActiveIdx: -1,      // 키보드 네비게이션 선택 인덱스

  // ----- 테마/패널 -----
  theme: localStorage.getItem('theme') || 'dark',
  favoritesPanelCollapsed: (localStorage.getItem('favorites_collapsed') === '1'),

  // ----- 컨텍스트 메뉴 -----
  activeContextMenu: null,
  contextMenuCloseHandler: null,

  // ----- 싱글턴 -----
  flatpickrInstance: null,
  timerInterval: null,
}
