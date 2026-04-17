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

  if (!isLoggedIn()) {
    app.innerHTML = renderLoginScreen()
    bindLoginEvents()
    return
  }

  app.innerHTML = `
    ${renderHeader()}
    ${renderActiveSessions()}
    ${renderTabs()}
    ${renderContent()}
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
