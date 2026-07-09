// 액션 레이어 — 비동기 데이터 로더 / 새로고침 / 검색.
// 책임: jira API 호출 + storage 캐시 갱신 + state 변경 + render 트리거.
// (원본 data는 jira.js / storage.js / state.js, view는 render.js. 이 파일은 그 둘을 잇는 동작 단위.)
import { state } from './state.js'
import {
  loadIssuesCache,
  saveIssuesCache,
  saveWorklogCache,
  getCachedMonth,
  mergeLogs,
  syncIssueSummariesFromList,
} from './storage.js'
import { getSavedUser } from './auth.js'
import {
  fetchMyIssues,
  fetchProjects,
  fetchMyWorklogs,
  fetchActiveSprintIssueKeys,
  searchIssuesByKey,
} from './jira.js'
import { showToast } from './ui.js'
import { render, resetIssueListScroll } from './render.js'
import { getProjectKeysOrFallback } from './utils.js'
import { prewarmTransitionCatalog } from './transitionCatalog.js'
import { markIssuesFlashing } from './issueFlash.js'

export async function loadIssues() {
  if (state.issuesLoading) return

  const userName = getSavedUser()?.displayName || ''

  // 1) 캐시가 있으면 즉시 표시
  const cached = loadIssuesCache()
  if (cached) {
    state.realIssues = cached.issues
    state.realProjects = cached.projects
    state.issuesLoaded = true
    render()
  }

  // 2) API에서 최신 데이터 가져오기
  if (!cached) {
    state.issuesLoading = true
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
    const hasChanged = !cached || JSON.stringify(freshIssues.map(i => i.key).sort()) !== JSON.stringify((cached.issues || []).map(i => i.key).sort())

    state.realIssues = freshIssues
    state.realProjects = freshProjects
    state.issuesLoaded = true
    saveIssuesCache(freshIssues, freshProjects)
    syncIssueSummariesFromList(freshIssues)
    // 화면에 보이는 (프로젝트|유형|상태) 조합의 전이 목록을 백그라운드로 미리 캐싱
    prewarmTransitionCatalog(freshIssues).catch(() => {})

    if (cached) {
      if (hasChanged) {
        showToast(`이슈 목록이 업데이트되었습니다.`, '✓')
      } else {
        showToast('이미 최신 이슈 목록입니다.', '✓')
      }
    }
  } catch (e) {
    console.error('이슈 로드 실패:', e)
    // 초기 로드(캐시 없음)에서 실패하면 화면이 빈 상태로만 남아 사용자가 상황을 모름
    if (!cached) {
      showToast('이슈 목록을 불러오지 못했습니다. 새로고침 버튼을 눌러 다시 시도해 주세요.', '⚠')
    }
  }

  state.issuesLoading = false
  render()

  // 로그 탭이 활성 상태이면 worklog도 로드
  if (state.issuesLoaded && state.currentMainTab === 'logs') {
    loadWorklogs(state.calendarYear, state.calendarMonth)
  }
}

export async function loadWorklogs(year, month) {
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`
  if (state.worklogsLoadedMonths.has(monthKey) || state.worklogsLoading) return

  const userName = getSavedUser()?.displayName || ''

  // 1) 캐시가 있으면 즉시 표시 (stale)
  const cached = getCachedMonth(monthKey)
  if (cached) {
    mergeLogs(cached)
    render()
  }

  // 2) API에서 최신 데이터 가져오기 (revalidate)
  if (!cached) {
    state.worklogsLoading = true
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
    const hasChanged = !cached || JSON.stringify(cached) !== JSON.stringify(freshLogs)

    // 해당 월의 기존 데이터 제거 후 새 데이터 병합
    for (const key of Object.keys(state.worklogsByDate)) {
      if (key.startsWith(monthKey)) delete state.worklogsByDate[key]
    }
    mergeLogs(freshLogs)
    state.worklogsLoadedMonths.add(monthKey)

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

  state.worklogsLoading = false
  render()
}

// 특정 월 worklog를 render() 없이 조용히 로드 (모달 폼 유지용)
// 1) 메모리에 이미 있으면 그대로 사용
// 2) localStorage 캐시에 있으면 즉시 병합 후 반환 (네트워크 호출 X)
// 3) 그 외에만 API 호출
// force=true면 1)·2) 캐시를 무시하고 항상 Jira에서 재조회한다(위젯 등 외부에서
// 추가된 최신 worklog를 반영해야 하는 경우 — 예: '직전 종료 시간으로').
export async function ensureMonthWorklogsLoaded(year, month, { force = false } = {}) {
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`
  if (!force && state.worklogsLoadedMonths.has(monthKey)) return

  if (!force) {
    const cached = getCachedMonth(monthKey)
    if (cached) {
      mergeLogs(cached)
      state.worklogsLoadedMonths.add(monthKey)
      return
    }
  }

  const startDate = `${year}-${String(month + 1).padStart(2, '0')}-01`
  const lastDay = new Date(year, month + 1, 0).getDate()
  const endDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  const fresh = await fetchMyWorklogs(startDate, endDate)
  for (const key of Object.keys(state.worklogsByDate)) {
    if (key.startsWith(monthKey)) delete state.worklogsByDate[key]
  }
  mergeLogs(fresh)
  state.worklogsLoadedMonths.add(monthKey)
  saveWorklogCache(monthKey, fresh)
}

// 이슈 목록 강제 새로고침
export async function refreshIssues() {
  if (state.issuesLoading) return
  const userName = getSavedUser()?.displayName || ''
  state.issuesLoading = true
  // 스프린트 캐시 초기화 (다음에 필요해지면 재조회)
  state.activeSprintKeys = null
  render()
  showToast(`${userName}님의 이슈 목록을 업데이트합니다.`, '🔄')
  try {
    const promises = [fetchMyIssues(), fetchProjects()]
    if (state.showSprintOnly) promises.push(fetchActiveSprintIssueKeys())
    const [freshIssues, freshProjects, sprintKeys] = await Promise.all(promises)
    if (state.showSprintOnly) state.activeSprintKeys = new Set(sprintKeys || [])
    const oldKeys = JSON.stringify(state.realIssues.map(i => i.key).sort())
    const newKeys = JSON.stringify(freshIssues.map(i => i.key).sort())
    state.realIssues = freshIssues
    state.realProjects = freshProjects
    state.issuesLoaded = true
    saveIssuesCache(freshIssues, freshProjects)
    syncIssueSummariesFromList(freshIssues)
    prewarmTransitionCatalog(freshIssues).catch(() => {})
    if (oldKeys !== newKeys) {
      showToast('이슈 목록이 업데이트되었습니다.', '✓')
    } else {
      showToast('이미 최신 이슈 목록입니다.', '✓')
    }
  } catch (e) {
    console.error('이슈 새로고침 실패:', e)
    showToast('이슈 새로고침에 실패했습니다.', '⚠')
  }
  state.issuesLoading = false
  render()
}

// 자동 새로고침: 토스트/로딩 스피너 없이 조용히 이슈 + 현재 월 작업 로그를 재조회
// 사용자 액션 5분 비활동 후 호출되며, 데이터가 바뀌었어도 토스트 알림 없이 화면만 갱신
// 이슈와 워크로그를 병렬 호출 (서로 독립이라 순차로 할 이유가 없음)
// 이슈 목록의 "표시되는 변경" 감지용 서명(요약/상태/담당/부모/역할). 값이 바뀌면 변경으로 본다.
function issueSig(iss) {
  // updated(최종수정시각)를 포함 → 설명·댓글·워크로그 등 목록에 안 보이는 변경도 감지.
  return JSON.stringify([iss.updated, iss.summary, iss.status, iss.statusCategory, iss.type, iss.assignee, iss.parent, iss.role])
}
function issueSigMap(issues) {
  const m = new Map()
  if (Array.isArray(issues)) for (const iss of issues) if (iss?.key) m.set(iss.key, issueSig(iss))
  return m
}
// prev(서명맵) 대비 "기존에 있던 이슈인데 내용이 바뀐" 키만 반환.
// 신규 진입/목록 이탈은 제외해 노이즈(예: 완료 30일 창 이동)를 막는다.
function changedIssueKeys(prevSig, freshIssues) {
  const changed = []
  if (!Array.isArray(freshIssues)) return changed
  for (const iss of freshIssues) {
    if (!iss?.key) continue
    const before = prevSig.get(iss.key)
    if (before !== undefined && before !== issueSig(iss)) changed.push(iss.key)
  }
  return changed
}

// options.flash: true면 갱신 전/후를 비교해 변경된 이슈 행을 잠깐 강조한다.
// (웹훅 트리거·유휴 5분 폴링 등 백그라운드 갱신에서만 사용; 최초 로드/수동 새로고침은 미강조)
export async function autoReloadIssuesAndWorklogs(options = {}) {
  const { flash = false } = options
  if (state.issuesLoading || state.worklogsLoading) return

  const year = state.calendarYear
  const month = state.calendarMonth
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`
  const startDate = `${year}-${String(month + 1).padStart(2, '0')}-01`
  const lastDay = new Date(year, month + 1, 0).getDate()
  const endDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  // 갱신 전 이슈 서명 스냅샷(강조 대상 판별용)
  const prevSig = flash ? issueSigMap(state.realIssues) : null
  let changedKeys = []

  const issuesTask = (async () => {
    const promises = [fetchMyIssues(), fetchProjects()]
    if (state.showSprintOnly) promises.push(fetchActiveSprintIssueKeys())
    const [freshIssues, freshProjects, sprintKeys] = await Promise.all(promises)
    if (state.showSprintOnly) state.activeSprintKeys = new Set(sprintKeys || [])
    if (prevSig && prevSig.size) changedKeys = changedIssueKeys(prevSig, freshIssues)
    state.realIssues = freshIssues
    state.realProjects = freshProjects
    state.issuesLoaded = true
    saveIssuesCache(freshIssues, freshProjects)
    syncIssueSummariesFromList(freshIssues)
    prewarmTransitionCatalog(freshIssues).catch(() => {})
  })().catch(e => { console.error('이슈 자동 새로고침 실패:', e); return Promise.reject(e) })

  const worklogsTask = (async () => {
    const freshLogs = await fetchMyWorklogs(startDate, endDate)
    for (const key of Object.keys(state.worklogsByDate)) {
      if (key.startsWith(monthKey)) delete state.worklogsByDate[key]
    }
    mergeLogs(freshLogs)
    state.worklogsLoadedMonths.add(monthKey)
    saveWorklogCache(monthKey, freshLogs)
  })().catch(e => { console.error('작업 로그 자동 새로고침 실패:', e); return Promise.reject(e) })

  // allSettled로 한쪽이 실패해도 다른 쪽 결과는 반영
  const results = await Promise.allSettled([issuesTask, worklogsTask])
  const anyUpdated = results.some(r => r.status === 'fulfilled')
  // 강조 등록은 render 전에 — 렌더가 해당 행에 클래스/지연을 그린다.
  // 한 번에 너무 많이 바뀌면(캐시 스키마 변화 등 체계적 변동) 폭주 방지 위해 강조 생략.
  if (flash && changedKeys.length && changedKeys.length <= 12) markIssuesFlashing(changedKeys)
  if (anyUpdated) render()
}

// 현재 월 작업 로그 강제 새로고침
export async function refreshWorklogs() {
  if (state.worklogsLoading) return
  const userName = getSavedUser()?.displayName || ''
  const year = state.calendarYear
  const month = state.calendarMonth
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`
  state.worklogsLoadedMonths.delete(monthKey)
  state.worklogsLoading = true
  render()
  showToast(`${userName}님의 작업 기록을 업데이트합니다.`, '🔄')
  try {
    const startDate = `${year}-${String(month + 1).padStart(2, '0')}-01`
    const lastDay = new Date(year, month + 1, 0).getDate()
    const endDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    const freshLogs = await fetchMyWorklogs(startDate, endDate)
    const oldSnapshot = JSON.stringify(
      Object.keys(state.worklogsByDate)
        .filter(k => k.startsWith(monthKey))
        .reduce((acc, k) => { acc[k] = state.worklogsByDate[k]; return acc }, {})
    )
    for (const key of Object.keys(state.worklogsByDate)) {
      if (key.startsWith(monthKey)) delete state.worklogsByDate[key]
    }
    mergeLogs(freshLogs)
    state.worklogsLoadedMonths.add(monthKey)
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
  state.worklogsLoading = false
  render()
}

export async function performSearch() {
  const query = state.searchQuery.trim()
  if (!query) return
  state.searchLoading = true
  render()
  // 렌더 후 포커스 복원
  const input = document.getElementById('issue-search')
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length) }

  let results
  try {
    const projectKeys = getProjectKeysOrFallback()
    results = await searchIssuesByKey(query, projectKeys)
  } catch (e) {
    console.error('검색 실패:', e)
    results = []
  }

  // race 가드: API 응답이 돌아올 때쯤 사용자가 검색어를 바꿨거나 지운 경우
  // 이전 쿼리 결과가 최신 상태를 덮어쓰지 않도록 현재 state.searchQuery와 비교
  const currentQuery = state.searchQuery.trim()
  if (currentQuery !== query) {
    // 검색어가 비워졌거나(취소) 다른 쿼리로 바뀐 상태면 조용히 버림.
    // 후자는 더 새로운 performSearch가 진행 중이라 그쪽이 결과를 반영할 것.
    return
  }

  state.searchResults = results
  state.searchLoading = false
  render()
  resetIssueListScroll()
  document.getElementById('issue-search')?.focus()
}
