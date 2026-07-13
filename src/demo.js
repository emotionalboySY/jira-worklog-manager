import { state } from './state.js'

const DEMO_USER = {
  accountId: 'demo-user',
  displayName: '김매일',
}

const DEMO_PROJECTS = [
  { key: 'DKT', name: '매일국어T' },
  { key: 'DD', name: '독도' },
  { key: 'DK', name: '매일국어' },
  { key: 'RM', name: '리딩수학과학' },
]

const DEMO_ISSUES = [
  { key: 'DKT-482', summary: '학습 현황 대시보드 사용성 개선', type: 'story', status: '진행중', statusCategory: 'indeterminate', role: 'assignee' },
  { key: 'DKT-479', summary: '선생님용 과제 배포 화면 정리', type: 'task', status: '검토', statusCategory: 'indeterminate', role: 'assignee', parent: { key: 'DKT-450', type: '에픽', summary: '과제 관리 개선' } },
  { key: 'DD-238', summary: '콘텐츠 검색 필터 조건 추가', type: 'task', status: '진행중', statusCategory: 'indeterminate', role: 'reporter' },
  { key: 'DK-391', summary: '일일 학습 리포트 문구 수정', type: 'operation', status: '준비', statusCategory: 'new', role: 'assignee' },
  { key: 'RM-126', summary: '진도율 계산 오류 수정', type: 'bug', status: '대기', statusCategory: 'new', role: 'watcher' },
  { key: 'DKT-468', summary: '학생 목록 내려받기 기능 개선', type: 'story', status: '배포대기', statusCategory: 'indeterminate', role: 'reporter' },
  { key: 'DD-225', summary: '독도 학습 결과 안내 문구 검수', type: 'task', status: '완료', statusCategory: 'done', role: 'assignee' },
]

function toDateString(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function shiftDate(date, days) {
  const shifted = new Date(date)
  shifted.setDate(shifted.getDate() + days)
  return shifted
}

function makeLog(worklogId, issueKey, summary, startTime, endTime, durationMinutes, comment = '') {
  return { worklogId, issueKey, summary, startTime, endTime, durationMinutes, comment }
}

function buildDemoWorklogs() {
  const today = new Date()
  const worklogs = {}
  const templates = [
    [
      makeLog('demo-1', 'DKT-482', '학습 현황 대시보드 사용성 개선', '09:10', '11:30', 140, '대시보드 지표와 카드 배치 개선'),
      makeLog('demo-2', 'DD-238', '콘텐츠 검색 필터 조건 추가', '12:30', '15:20', 170, '검색 조건 및 빈 결과 화면 구현'),
      makeLog('demo-3', 'DKT-479', '선생님용 과제 배포 화면 정리', '15:30', '18:00', 150, '기획 검토 의견 반영'),
    ],
    [
      makeLog('demo-4', 'DK-391', '일일 학습 리포트 문구 수정', '09:00', '11:20', 140, '운영 요청 문구 반영'),
      makeLog('demo-5', 'DKT-482', '학습 현황 대시보드 사용성 개선', '12:30', '17:40', 310, '차트 상호작용 및 반응형 레이아웃 적용'),
    ],
    [
      makeLog('demo-6', 'RM-126', '진도율 계산 오류 수정', '09:20', '11:30', 130, '재현 조건 확인 및 계산식 수정'),
      makeLog('demo-7', 'DKT-468', '학생 목록 내려받기 기능 개선', '12:30', '17:50', 320, '대용량 내려받기 흐름 점검'),
    ],
    [
      makeLog('demo-8', 'DD-238', '콘텐츠 검색 필터 조건 추가', '09:00', '11:30', 150, '필터 UI 마무리'),
      makeLog('demo-9', 'DKT-479', '선생님용 과제 배포 화면 정리', '12:30', '18:00', 330, '검토 의견 반영 및 테스트'),
    ],
    [
      makeLog('demo-10', 'DKT-482', '학습 현황 대시보드 사용성 개선', '09:10', '11:30', 140, '주요 화면 QA'),
      makeLog('demo-11', 'DK-391', '일일 학습 리포트 문구 수정', '12:30', '16:40', 250, '운영 배포 확인'),
    ],
  ]

  // 최근 평일과 지난주에 충분한 기록이 보이도록 역순으로 채운다.
  let templateIndex = 0
  for (let offset = 0; offset >= -12; offset--) {
    const date = shiftDate(today, offset)
    const day = date.getDay()
    if (day === 0 || day === 6) continue
    worklogs[toDateString(date)] = templates[templateIndex % templates.length].map((log, index) => ({
      ...log,
      worklogId: `${log.worklogId}-${offset}-${index}`,
    }))
    templateIndex += 1
  }
  return worklogs
}

export function isDemoMode() {
  return new URLSearchParams(window.location.search).get('demo') === '1'
}

export function getDemoUser() {
  return DEMO_USER
}

export function getDemoSessions() {
  const now = Date.now()
  return [
    {
      issueKey: 'DKT-482',
      summary: '학습 현황 대시보드 사용성 개선',
      status: 'active',
      segments: [{ start: new Date(now - 52 * 60 * 1000), end: null }],
    },
  ]
}

export function getDemoFavorites() {
  return [
    { issueKey: 'DKT-482', summary: '학습 현황 대시보드 사용성 개선' },
    { issueKey: 'DD-238', summary: '콘텐츠 검색 필터 조건 추가' },
  ]
}

export function setupDemoState() {
  const params = new URLSearchParams(window.location.search)
  const requestedView = params.get('view')
  const availableViews = new Set(['issues', 'logs', 'summary'])
  const today = new Date()

  document.body.classList.add('demo-mode')

  state.realProjects = DEMO_PROJECTS
  state.realIssues = DEMO_ISSUES
  state.issuesLoaded = true
  state.issuesLoading = false
  state.worklogsByDate = buildDemoWorklogs()
  state.worklogsLoadedMonths = new Set([toDateString(today).slice(0, 7)])
  state.worklogsLoading = false
  state.currentMainTab = availableViews.has(requestedView) ? requestedView : 'issues'
  state.logDate = toDateString(today)
  state.calendarYear = today.getFullYear()
  state.calendarMonth = today.getMonth()
  state.summaryWeekOffset = Number.parseInt(params.get('week') || '0', 10) || 0
  state.pageSize = 10
}
