// 비동기 데이터 로더 / 검색
import { state, WORKLOG_CACHE_KEY } from './state.js'
import {
  loadIssuesCache,
  saveIssuesCache,
  loadWorklogCache,
  saveWorklogCache,
  getCachedMonth,
  mergeLogs,
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
export async function ensureMonthWorklogsLoaded(year, month) {
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`
  if (state.worklogsLoadedMonths.has(monthKey)) return

  const cached = getCachedMonth(monthKey)
  if (cached) {
    mergeLogs(cached)
    state.worklogsLoadedMonths.add(monthKey)
    return
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
  if (!state.searchQuery.trim()) return
  state.searchLoading = true
  render()
  // 렌더 후 포커스 복원
  const input = document.getElementById('issue-search')
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length) }

  try {
    const projectKeys = state.realProjects.length > 0
      ? state.realProjects.map(p => p.key)
      : ['DK', 'DKT', 'DD', 'RM']
    state.searchResults = await searchIssuesByKey(state.searchQuery.trim(), projectKeys)
  } catch (e) {
    console.error('검색 실패:', e)
    state.searchResults = []
  }

  state.searchLoading = false
  render()
  // 검색 결과는 새로운 리스트이므로 상단부터 보여줌
  resetIssueListScroll()
  document.getElementById('issue-search')?.focus()
}
