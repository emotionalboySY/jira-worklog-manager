// 로그인 화면
import { login, getLastAuthError, clearLastAuthError } from '../auth.js'
import { escapeHtml } from '../utils.js'

export function renderLoginScreen() {
  // 직전 로그인 실패가 있으면 사유를 화면에 노출 (외부 조직 사용자 디버깅용)
  const err = getLastAuthError()
  const errorHtml = err ? `
    <div class="login-error" role="alert">
      <div class="login-error-title">⚠ 로그인하지 못했습니다</div>
      <div class="login-error-msg">${escapeHtml(err.message)}</div>
      ${err.detail ? `<div class="login-error-detail">${escapeHtml(err.detail)}</div>` : ''}
      <div class="login-error-code">오류 코드: ${escapeHtml(err.code)}</div>
    </div>
  ` : ''

  return `
    <div class="login-screen">
      <span class="header-logo" style="font-size: 28px;">Jira 작업 로그 매니저</span>
      <p class="login-desc">Jira 계정으로 로그인하여 작업 시간을 관리하세요.</p>
      ${errorHtml}
      <button class="btn btn-primary btn-login" id="btn-login">Jira로 로그인</button>
    </div>
  `
}

export function bindLoginEvents() {
  const loginBtn = document.getElementById('btn-login')
  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      // 재시도 시 이전 에러 잔상 제거 (리다이렉트 전이라 화면엔 안 보이지만 상태 정리)
      clearLastAuthError()
      login()
    })
  }
}
