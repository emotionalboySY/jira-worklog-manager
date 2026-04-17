// 최상위 render 오케스트레이터
import { state } from './state.js'
import { isLoggedIn } from './auth.js'
import { renderLoginScreen, bindLoginEvents } from './views/login.js'
import { renderHeader, renderTabs, renderContent } from './views/header.js'
import { renderActiveSessions } from './views/sessions.js'
import { renderFavoritesPanel } from './views/favorites.js'
import {
  renderModal,
  renderCancelConfirm,
  renderEditWorklogModal,
  renderDeleteWorklogConfirm,
  renderManualLogModal,
} from './views/modals.js'
import { bindEvents, startTimerUpdate } from './events.js'

export function render() {
  if (state.flatpickrInstance) {
    state.flatpickrInstance.destroy()
    state.flatpickrInstance = null
  }
  const app = document.querySelector('#app')

  // 현재 탭을 body 클래스로 노출해 탭별 레이아웃 제어 (이슈 탭 내부 스크롤 등)
  document.body.classList.remove('tab-issues', 'tab-logs', 'tab-summary', 'logged-out')
  if (!isLoggedIn()) {
    document.body.classList.add('logged-out')
    app.innerHTML = renderLoginScreen()
    bindLoginEvents()
    return
  }
  document.body.classList.add(`tab-${state.currentMainTab}`)

  app.innerHTML = `
    ${renderHeader()}
    ${renderActiveSessions()}
    ${renderTabs()}
    <div class="tab-content">${renderContent()}</div>
    ${renderFavoritesPanel()}
    ${state.showModal ? renderModal() : ''}
    ${state.showCancelConfirm ? renderCancelConfirm() : ''}
    ${state.editingWorklog ? renderEditWorklogModal() : ''}
    ${state.deletingWorklog ? renderDeleteWorklogConfirm() : ''}
    ${state.showManualLog ? renderManualLogModal() : ''}
  `
  bindEvents()
  startTimerUpdate()
}
