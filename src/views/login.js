// 로그인 화면
import { login } from '../auth.js'

export function renderLoginScreen() {
  return `
    <div class="login-screen">
      <span class="header-logo" style="font-size: 28px;">Jira 작업 로그 매니저</span>
      <p class="login-desc">Jira 계정으로 로그인하여 작업 시간을 관리하세요.</p>
      <button class="btn btn-primary btn-login" id="btn-login">Jira로 로그인</button>
    </div>
  `
}

export function bindLoginEvents() {
  const loginBtn = document.getElementById('btn-login')
  if (loginBtn) {
    loginBtn.addEventListener('click', () => login())
  }
}
