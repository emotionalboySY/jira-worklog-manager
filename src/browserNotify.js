// 데스크톱(브라우저) 알림 — 방식 A.
// issueChanges.js가 감지한 이슈 변경을 화면 내 토스트뿐 아니라 OS 알림 센터에도 띄운다.
// 크롬이 켜져 있고 이 앱 탭이 살아 있는 동안만 동작한다(서비스워커/서버 푸시 아님).
//
// 권한(Notification.permission)과 사용자 켜기/끄기(localStorage)를 분리해 둘 다 만족할 때만 표시:
//   - 권한은 브라우저가 관리(granted/denied/default) — 사용자가 브라우저 UI로만 바꿀 수 있음
//   - 켜기/끄기는 우리 토글(브라우저·기기 단위 설정이라 계정별 아닌 localStorage에 저장)
//
// 표시 시점: '창이 비활성일 때'만(다른 탭·다른 앱을 보는 중). 앱을 보고 있을 땐 토스트로 충분하고
// OS 알림까지 겹치면 방해가 되므로 document.hasFocus()가 false일 때만 띄운다.

const PREF_KEY = 'browser_notify_enabled'
const TAG = 'jira-issue-change' // 같은 tag는 알림 센터에서 하나로 합쳐져 쌓이지 않음

export function isBrowserNotifySupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

// 브라우저가 기억하는 권한 상태. 미지원이면 'unsupported'.
export function notifyPermission() {
  return isBrowserNotifySupported() ? Notification.permission : 'unsupported'
}

function prefEnabled() {
  return localStorage.getItem(PREF_KEY) === '1'
}

// 실제로 OS 알림을 띄울 수 있는 상태인가 = 권한 granted + 사용자 켬.
export function isBrowserNotifyOn() {
  return isBrowserNotifySupported() && Notification.permission === 'granted' && prefEnabled()
}

// 토글·안내 렌더용 상태 스냅샷.
export function getNotifyStatus() {
  return {
    supported: isBrowserNotifySupported(),
    permission: notifyPermission(), // 'granted' | 'denied' | 'default' | 'unsupported'
    on: isBrowserNotifyOn(),
  }
}

// 켜기: 사용자 제스처(토글 클릭) 안에서 호출해야 권한 프롬프트가 뜬다.
// 반환: 처리 후의 getNotifyStatus() (호출부가 토스트로 결과 안내).
export async function enableBrowserNotify() {
  if (!isBrowserNotifySupported()) return getNotifyStatus()
  let perm = Notification.permission
  if (perm === 'default') {
    try { perm = await Notification.requestPermission() } catch { perm = Notification.permission }
  }
  // 허용됐을 때만 켬으로 저장. 거부/미결정이면 켜지 않는다.
  if (perm === 'granted') localStorage.setItem(PREF_KEY, '1')
  return getNotifyStatus()
}

export function disableBrowserNotify() {
  localStorage.setItem(PREF_KEY, '0')
}

// OS 알림 1건 표시. 켜져 있고 창이 비활성일 때만.
// title/body는 issueChanges.js가 만든 사람 읽기용 문자열.
export function showDesktopNotification(title, body) {
  if (!isBrowserNotifyOn()) return
  // 앱을 보고 있으면 토스트로 충분 — 겹치는 OS 알림은 생략.
  if (typeof document !== 'undefined' && document.hasFocus()) return
  try {
    const n = new Notification(title, {
      body,
      tag: TAG,
      renotify: true,       // 같은 tag여도 새 배치마다 다시 알림
      icon: '/favicon.svg',
      silent: false,
    })
    // 알림 클릭 → 앱 창으로 포커스 이동.
    n.onclick = () => { try { window.focus() } catch {} ; n.close() }
  } catch (e) {
    // 일부 환경(포커스 요건 등)에서 생성 실패할 수 있음 — 토스트는 이미 떴으므로 조용히 무시.
    console.debug('데스크톱 알림 표시 실패:', e?.message)
  }
}
