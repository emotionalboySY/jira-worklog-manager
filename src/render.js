// 최상위 render 오케스트레이터
// 섹션별 컨테이너로 앱을 나누고, 필요한 섹션만 갱신하는 부분 렌더링 지원.
// 호출 예:
//   render()                          → 전체 섹션 재렌더
//   render({ sections: ['modals'] })  → 해당 섹션만 갱신 (나머지 DOM/상태 유지)
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
import { renderSettingsFab, renderSettingsModal } from './views/settings.js'
import { bindEvents, startTimerUpdate } from './events.js'

let shellInitialized = false

function renderModalsHtml() {
  return `
    ${state.showModal ? renderModal() : ''}
    ${state.showCancelConfirm ? renderCancelConfirm() : ''}
    ${state.editingWorklog ? renderEditWorklogModal() : ''}
    ${state.deletingWorklog ? renderDeleteWorklogConfirm() : ''}
    ${state.showManualLog ? renderManualLogModal() : ''}
    ${state.showSettings ? renderSettingsModal() : ''}
  `
}

// 섹션 이름 → (컨테이너 id, 렌더 함수)
const SECTIONS = {
  header:        { id: 'sec-header',       render: renderHeader },
  sessions:      { id: 'sec-sessions',     render: renderActiveSessions },
  tabs:          { id: 'sec-tabs',         render: renderTabs },
  content:       { id: 'sec-content',      render: renderContent },
  favorites:     { id: 'sec-favorites',    render: renderFavoritesPanel },
  'settings-fab':{ id: 'sec-settings-fab', render: renderSettingsFab },
  modals:        { id: 'sec-modals',       render: renderModalsHtml },
}
const ALL_SECTIONS = Object.keys(SECTIONS)

function ensureShell(app) {
  if (shellInitialized) return
  app.innerHTML = `
    <div id="sec-header"></div>
    <div id="sec-sessions"></div>
    <div id="sec-tabs"></div>
    <div id="sec-content" class="tab-content"></div>
    <div id="sec-favorites"></div>
    <div id="sec-settings-fab"></div>
    <div id="sec-modals"></div>
  `
  shellInitialized = true
}

export function render(options = {}) {
  const app = document.querySelector('#app')

  // 로그아웃 상태는 전용 화면 (shell 재사용 안 함)
  if (!isLoggedIn()) {
    document.body.classList.remove('tab-issues', 'tab-logs', 'tab-summary')
    document.body.classList.add('logged-out')
    app.innerHTML = renderLoginScreen()
    bindLoginEvents()
    shellInitialized = false
    return
  }

  document.body.classList.remove('tab-issues', 'tab-logs', 'tab-summary', 'logged-out')
  document.body.classList.add(`tab-${state.currentMainTab}`)

  ensureShell(app)

  const sections = options.sections || ALL_SECTIONS

  // content 섹션이 재렌더되면 내부 flatpickr 인스턴스가 사라지므로 먼저 정리
  if (sections.includes('content') && state.flatpickrInstance) {
    state.flatpickrInstance.destroy()
    state.flatpickrInstance = null
  }

  for (const name of sections) {
    const spec = SECTIONS[name]
    if (!spec) continue
    const container = document.getElementById(spec.id)
    if (container) container.innerHTML = spec.render()
  }

  // 이벤트 재바인딩: on() 헬퍼가 이미 바인드된 element는 자동 스킵하므로
  // 갱신된 섹션의 새 element에만 리스너가 추가된다.
  bindEvents()
  startTimerUpdate()
}
