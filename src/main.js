// 엔트리: 스타일 로드, 초기화 흐름만 담당
// (flatpickr CSS는 events/calendar.js에서 라이브러리와 함께 lazy 로드)
import './style.css'
import { handleOAuthCallback, isLoggedIn, fetchCurrentUser, saveUser, getSavedUser } from './auth.js'
import { applyTheme, applyPreferences, showToast } from './ui.js'
import { loadPreferences } from './storage.js'
import { render, registerPostRender } from './render.js'
import { loadIssues } from './actions.js'
import { setupAutoReload } from './autoReload.js'
import { resetInMemoryUserData } from './state.js'
import { installDelegatedHandlers, bindEvents, startTimerUpdate } from './events.js'
import { initSessionSync, stopSessionPolling, setSessionRenderHook } from './sessionSync.js'
import { clearTransitionCatalog } from './transitionCatalog.js'

// 토큰 갱신 실패로 자동 로그아웃이 일어나면 즉시 로그인 화면으로 전환 + 사용자 안내
let authClearedHandled = false
window.addEventListener('jira-auth-cleared', () => {
  if (authClearedHandled) return
  authClearedHandled = true
  // 세션 백엔드 폴링 중단 + 직전 사용자의 in-memory 데이터(이슈/워크로그/캐시 Map들) 정리
  try { stopSessionPolling() } catch {}
  try { resetInMemoryUserData() } catch {}
  try { clearTransitionCatalog() } catch {}
  try { showToast('세션이 만료되었습니다. 다시 로그인해주세요.', '⚠') } catch {}
  try { window.alert('세션이 만료되었습니다. 다시 로그인해주세요.') } catch {}
  render()
})

// ========== 초기화 ==========
async function init() {
  try {
    // 이벤트 위임 1회 설치 — handleGlobalClick(bindEvents에서 등록)보다 먼저 등록되도록
    // init 첫 단계에 호출. document 리스너 순서가 클릭 후 handleGlobalClick 호출 보장에 중요.
    installDelegatedHandlers()

    // render 종료 시점마다 호출될 hook 등록 (render.js는 events.js를 import하지 않음 — 모듈 순환 해소)
    registerPostRender(bindEvents)
    registerPostRender(startTimerUpdate)
    setSessionRenderHook(render)

    applyTheme()
    applyPreferences(loadPreferences())

    // OAuth 콜백 처리 (로그인 후 리다이렉트된 경우)
    await handleOAuthCallback()

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

    // 로그인 상태면 이슈 목록 로드 + 자동 재로드 활성화
    if (isLoggedIn()) {
      loadIssues()
      setupAutoReload()
      initSessionSync()
    }
  } catch (e) {
    console.error('초기화 실패:', e)
    // 빈 화면 방지: 최소한 로그인/현재 상태 화면이라도 띄움
    try { render() } catch {}
  }
}

init()
