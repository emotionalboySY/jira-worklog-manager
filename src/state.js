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

export const LUNCH_START = 11 * 60 + 30 // 11:30 (분 단위)
export const LUNCH_END = 12 * 60 + 30   // 12:30 (분 단위)

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

// ===== 정렬 순서 기본값 (사용자가 설정에서 재배치 가능) =====
// 배열 순서 = 위→아래. indexOf로 우선순위 결정.
export const DEFAULT_STATUS_ORDER = [
  '진행중',
  '검토',
  '배포대기',
  '준비',
  '대기',
  '완료됨',
  '완료',
  '보류',
  '보류(Closed)',
  'Closed',
]

export const DEFAULT_PROJECT_ORDER = ['DK', 'DKT', 'DD', 'RM']

// 요약 탭 주 시작 요일: 'thursday' (목~수, 기본) | 'monday' (월~일)
export const DEFAULT_SUMMARY_WEEK_START = 'thursday'

// ===== 프로젝트별 색상 기본값 =====
// bar = 메인 색(컬러 바, 호버 배경), fg = 밝은 텍스트, bg = 투명 배경
export const DEFAULT_PROJECT_COLORS = {
  DK:  { bar: '#3b82f6', fg: '#60a5fa', bg: 'rgba(59, 130, 246, 0.14)' },   // 파랑
  DKT: { bar: '#10b981', fg: '#34d399', bg: 'rgba(16, 185, 129, 0.14)' },   // 초록
  DD:  { bar: '#f97316', fg: '#fb923c', bg: 'rgba(249, 115, 22, 0.14)' },   // 주황
  RM:  { bar: '#a855f7', fg: '#c084fc', bg: 'rgba(168, 85, 247, 0.14)' },   // 보라
}
export const CLOSED_CATEGORY = 'done'  // Jira statusCategory key

// localStorage 키
export const SESSIONS_KEY = 'work_sessions'
export const DAY_OFFS_KEY = 'day_offs'
export const FAVORITES_KEY = 'favorite_issues'
export const ISSUES_CACHE_KEY = 'issues_cache'
export const WORKLOG_CACHE_KEY = 'worklog_cache'
export const WORKLOG_CACHE_MAX_MONTHS = 3
export const PREFERENCES_KEY = 'user_preferences'

// 이슈 키 형식 검사 (예: DKT-123)
export const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/

// 일감 없이 시작된 작업 세션을 식별하는 센티넬 키
// (Jira 키 패턴과 충돌하지 않도록 언더스코어 포함)
export const NO_ISSUE_KEY = '__NO_ISSUE__'
export const NO_ISSUE_SUMMARY = '(일감 미지정)'

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
  showSettings: false,     // 설정 모달 표시 여부
  settingsDraft: null,     // 설정 모달에서 편집 중인 임시 값 (저장 전)
  // 이슈 상세 모달: null | { key, loading, data, error, blobUrls, editing, editBuffer, editInitial, saving, saveError, lossyFeatures }
  // editing=true면 설명 편집 모드, editBuffer에 markdown 문자열
  issueDetailModal: null,

  // ----- 사용자 설정 (저장된 값) -----
  userPrefs: {
    statusOrder: [...DEFAULT_STATUS_ORDER],
    projectOrder: [...DEFAULT_PROJECT_ORDER],
    projectColors: JSON.parse(JSON.stringify(DEFAULT_PROJECT_COLORS)),
    summaryWeekStart: DEFAULT_SUMMARY_WEEK_START,
  },
  manualIssueCheck: null,  // 이슈 키 검증 결과: null | { status: 'checking'|'ok'|'error', key, summary, message }
  manualKeySearchTimer: null,  // 이슈 키 자동완성 API debounce 타이머
  manualKeySearchController: null,  // 자동완성 in-flight 요청 취소용
  manualKeyActiveIdx: -1,      // 키보드 네비게이션 선택 인덱스

  // 일감 미지정 세션의 종료 모달에서 이슈 키를 지정할 때 쓰는 상태 (manual-*과 동일 구조)
  finishIssueCheck: null,
  finishKeySearchTimer: null,
  finishKeySearchController: null,
  finishKeyActiveIdx: -1,

  // 세션 일감 교체 모달: { oldKey, summary } | null
  // (oldKey는 교체 대상 세션을 식별하고, 교체 완료 후 showModal/showCancelConfirm이 oldKey를 가리키고 있으면 새 키로 갱신)
  showSwapIssue: null,
  swapIssueCheck: null,
  swapKeySearchTimer: null,
  swapKeySearchController: null,
  swapKeyActiveIdx: -1,

  // 이슈 상태 전이: 이슈별 독립 로딩 트래킹 (전이 조회 OR 실행 중인 키 집합)
  // 한 이슈가 로딩 중이어도 다른 이슈의 전이 시도는 독립적으로 가능
  statusTransitioning: new Set(),
  // 상태 드롭다운: { issueKey, rect, transitions, loading } | null
  statusDropdown: null,
  // 추가 필드(resolution 등)를 요구하는 전이용 2차 모달:
  // { issueKey, transition, values, submitting } | null
  transitionFieldsModal: null,

  // 담당자 드롭다운: { issueKey, rect, allUsers, query, loading, _focused } | null
  // allUsers: 최초 1회 API 조회 결과. 검색은 로컬 필터(instant).
  assigneeDropdown: null,
  // 담당자 변경 진행 중인 이슈 키 집합 (아바타에 스피너 표시)
  assigneeUpdating: new Set(),

  // 이슈 유형 드롭다운: { issueKey, rect, types, loading, currentTypeName } | null
  typeDropdown: null,
  // 이슈 유형 변경 진행 중인 이슈 키 집합
  typeUpdating: new Set(),

  // ----- 테마/패널 -----
  theme: localStorage.getItem('theme') || 'dark',
  favoritesPanelCollapsed: (localStorage.getItem('favorites_collapsed') === '1'),

  // ----- 컨텍스트 메뉴 -----
  activeContextMenu: null,
  contextMenuCloseHandler: null,

  // ----- 다중 선택 (이슈 목록 일괄 복사) -----
  selectedIssues: new Set(),       // 선택된 이슈 키 집합
  lastSelectedIssueKey: null,      // shift+클릭 범위 선택의 기준점

  // ----- 싱글턴 -----
  flatpickrInstance: null,
  timerInterval: null,
}
