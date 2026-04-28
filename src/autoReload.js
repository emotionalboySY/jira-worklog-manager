// 사용자의 마지막 액션 이후 5분이 지나면 이슈/작업 로그를 자동 재로드.
// 액션이 발생하면 카운트다운을 리셋하고, 재로드 후엔 다시 5분 사이클을 시작한다.
import { state } from './state.js'
import { isLoggedIn } from './auth.js'
import { autoReloadIssuesAndWorklogs } from './data.js'

const IDLE_MS = 5 * 60 * 1000          // 5분
const RETRY_WHILE_BUSY_MS = 30 * 1000  // 모달/로딩 중일 때 재시도 간격
const ACTIVITY_THROTTLE_MS = 1000      // 활동 이벤트 처리 throttle (mousemove 등 방지)

let timer = null
let lastActivityHandledAt = 0
let setupDone = false

// 사용자가 입력/편집 중인 상태에서 새로고침이 일어나면 모달 입력 등이 초기화될 수 있으므로
// busy 상태에서는 잠깐 후 재시도한다.
function isBusyUI() {
  return !!(
    state.showModal ||
    state.showCancelConfirm ||
    state.editingWorklog ||
    state.deletingWorklog ||
    state.showManualLog ||
    state.showSettings ||
    state.showSwapIssue ||
    state.statusDropdown ||
    state.assigneeDropdown ||
    state.transitionFieldsModal ||
    state.issueDetailModal ||
    state.issuesLoading ||
    state.worklogsLoading
  )
}

function schedule(delay = IDLE_MS) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(perform, delay)
}

async function perform() {
  timer = null
  if (!isLoggedIn()) {
    schedule()
    return
  }
  if (isBusyUI()) {
    schedule(RETRY_WHILE_BUSY_MS)
    return
  }
  try {
    await autoReloadIssuesAndWorklogs()
  } catch (e) {
    console.error('자동 새로고침 실패:', e)
  }
  // 다음 5분 사이클 재시작 (사용자 액션이 없으면 또 5분 뒤 reload)
  schedule()
}

function onUserActivity() {
  const now = Date.now()
  if (now - lastActivityHandledAt < ACTIVITY_THROTTLE_MS) return
  lastActivityHandledAt = now
  schedule()
}

export function setupAutoReload() {
  if (setupDone) return
  setupDone = true
  // capture 단계에서 잡아 stopPropagation으로 막혀도 활동을 감지
  const events = ['click', 'keydown', 'pointerdown', 'mousemove', 'wheel', 'touchstart', 'scroll']
  for (const ev of events) {
    document.addEventListener(ev, onUserActivity, { passive: true, capture: true })
  }
  schedule()
}
