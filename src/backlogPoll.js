// 배포 예정(백로그) 뷰가 활성인 동안 주기적으로 백로그를 재조회한다.
// 3LO 동적 웹훅은 JQL이 'assignee/reporter = currentUser()' 범위로만 등록되어
// (Atlassian 제약상 watcher/타인 이슈는 실시간 감지 불가), 백로그에 표시되는
// 남의 이슈 변경은 웹훅으로 오지 않는다. 그래서 뷰가 켜져 있는 동안만 폴링한다.
import { state } from './state.js'
import { isLoggedIn } from './auth.js'
import { isBusyUI } from './utils.js'
import { refreshBacklogSilently } from './actions.js'

const POLL_MS = 40 * 1000 // 40초 간격

let timer = null
let visibilityBound = false

async function tick() {
  // 백로그 뷰가 활성이고 로드된 상태일 때만 동작 (그 외엔 값싸게 no-op)
  if (!isLoggedIn()) return
  // 백그라운드 탭이면 폴링 생략 — 불필요한 API 호출 방지.
  // (탭 복귀 시 visibilitychange 훅이 즉시 한 번 재조회하므로 공백 없음)
  if (document.hidden) return
  if (state.issueViewMode !== 'backlog') return
  if (!state.backlogProject || !state.backlogLoaded) return
  if (state.backlogLoading || isBusyUI()) return
  try {
    await refreshBacklogSilently({ flash: true })
  } catch (e) {
    console.error('백로그 폴링 실패:', e)
  }
}

// 탭이 다시 보이면(다른 창에서 Jira 변경 후 복귀 등) 즉시 한 번 재조회.
function onVisibilityChange() {
  if (document.visibilityState === 'visible') tick()
}

export function startBacklogPolling() {
  if (!visibilityBound) {
    document.addEventListener('visibilitychange', onVisibilityChange)
    visibilityBound = true
  }
  if (timer) return
  timer = setInterval(tick, POLL_MS)
}

export function stopBacklogPolling() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
