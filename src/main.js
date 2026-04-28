// 엔트리: 스타일/플랫픽커 CSS 로드, 초기화 흐름만 담당
import './style.css'
import 'flatpickr/dist/flatpickr.min.css'
import { handleOAuthCallback, isLoggedIn, fetchCurrentUser, saveUser, getSavedUser } from './auth.js'
import { applyTheme, applyPreferences } from './ui.js'
import { loadPreferences } from './storage.js'
import { render } from './render.js'
import { loadIssues } from './data.js'
import { setupAutoReload } from './autoReload.js'

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
