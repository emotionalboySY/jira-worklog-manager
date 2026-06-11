// 사용자의 마지막 액션 이후 5분이 지나면 이슈/작업 로그를 자동 재로드.
// 액션이 발생하면 카운트다운을 리셋하고, 재로드 후엔 다시 5분 사이클을 시작한다.
import { isLoggedIn } from './auth.js'
import { autoReloadIssuesAndWorklogs } from './actions.js'
// busy 판정은 utils.js의 단일 소스 사용 (sessionSync와 공유 — 모달 누락으로 인한
// "입력 중 전체 렌더로 입력값 증발"을 한 곳에서 방지)
import { isBusyUI } from './utils.js'

const IDLE_MS = 5 * 60 * 1000          // 5분
const RETRY_WHILE_BUSY_MS = 30 * 1000  // 모달/로딩 중일 때 재시도 간격
const ACTIVITY_THROTTLE_MS = 1000      // 활동 이벤트 처리 throttle (mousemove 등 방지)

let timer = null
let lastActivityHandledAt = 0
let setupDone = false

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
