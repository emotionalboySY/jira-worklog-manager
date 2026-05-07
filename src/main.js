// 엔트리: 스타일/플랫픽커 CSS 로드, 초기화 흐름만 담당
import './style.css'
import 'flatpickr/dist/flatpickr.min.css'
import { handleOAuthCallback, isLoggedIn, fetchCurrentUser, saveUser, getSavedUser } from './auth.js'
import { applyTheme, applyPreferences, showToast } from './ui.js'
import { loadPreferences } from './storage.js'
import { render } from './render.js'
import { loadIssues } from './data.js'
import { setupAutoReload } from './autoReload.js'

// 토큰 갱신 실패로 자동 로그아웃이 일어나면 즉시 로그인 화면으로 전환 + 사용자 안내
let authClearedHandled = false
window.addEventListener('jira-auth-cleared', () => {
  if (authClearedHandled) return
  authClearedHandled = true
  try { showToast('세션이 만료되었습니다. 다시 로그인해주세요.', '⚠') } catch {}
  try { window.alert('세션이 만료되었습니다. 다시 로그인해주세요.') } catch {}
  render()
})

// ========== 초기화 ==========
async function init() {
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
  }
}

init()
