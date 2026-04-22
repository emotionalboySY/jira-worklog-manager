// 테마 / 토스트 / 컨텍스트 메뉴
import { state } from './state.js'
import { getJiraIssueUrl, escapeHtml } from './utils.js'
import { render } from './render.js'

// ========== 테마 ==========
export function applyTheme() {
  if (state.theme === 'light') {
    document.documentElement.classList.add('light')
  } else {
    document.documentElement.classList.remove('light')
  }
}

export function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark'
  localStorage.setItem('theme', state.theme)
  applyTheme()
  // 헤더 섹션을 교체하면 스위치 DOM이 재생성되어 노브 슬라이드 transition이 실행되지 않음.
  // 테마 스위치 외에는 헤더에서 theme에 반응하는 요소가 없으므로 클래스만 토글.
  const btn = document.getElementById('btn-theme')
  if (btn) {
    btn.classList.toggle('light', state.theme === 'light')
    btn.classList.toggle('dark', state.theme === 'dark')
    btn.setAttribute('aria-checked', state.theme === 'dark' ? 'true' : 'false')
    btn.setAttribute('title', '테마 전환 (라이트 ↔ 다크)')
  }
}

// ========== 사용자 설정 적용 ==========
// prefs.projectColors를 CSS 변수로 주입하고 state.userPrefs 갱신.
// 정렬 순서는 state에만 반영 (sortIssues가 참조)
export function applyPreferences(prefs) {
  state.userPrefs = prefs
  const root = document.documentElement
  for (const [key, colors] of Object.entries(prefs.projectColors || {})) {
    if (!colors) continue
    if (colors.fg) root.style.setProperty(`--project-${key}-fg`, colors.fg)
    if (colors.bg) root.style.setProperty(`--project-${key}-bg`, colors.bg)
    if (colors.bar) root.style.setProperty(`--project-${key}-bar`, colors.bar)
  }
}

// ========== 토스트 알림 ==========
export function ensureToastContainer() {
  if (!document.getElementById('toast-container')) {
    const el = document.createElement('div')
    el.id = 'toast-container'
    el.className = 'toast-container'
    document.body.appendChild(el)
  }
  return document.getElementById('toast-container')
}

// icon → type 매핑 (호출부 변경 없이 색상만 자동 적용)
function inferToastType(icon) {
  if (icon === '✓') return 'success'
  if (icon === '⚠') return 'error'
  if (icon === '!') return 'warning'
  return 'info'
}

export function showToast(message, icon = 'ℹ', type = inferToastType(icon)) {
  const container = ensureToastContainer()
  const toast = document.createElement('div')
  toast.className = `toast toast-${type}`
  // message에는 사용자 입력(이슈 키, Jira 에러 본문 등)이 섞여 들어올 수 있어
  // textContent로 안전하게 삽입. 아이콘은 호출부에서 넘어오는 고정 문자이므로 그대로 사용.
  const iconEl = document.createElement('span')
  iconEl.className = 'toast-icon'
  iconEl.textContent = icon
  const msgEl = document.createElement('span')
  msgEl.className = 'toast-message'
  msgEl.textContent = String(message)
  toast.appendChild(iconEl)
  toast.appendChild(msgEl)
  container.appendChild(toast)
  setTimeout(() => {
    toast.classList.add('toast-out')
    toast.addEventListener('animationend', () => toast.remove())
  }, 3000)
}

// ========== 컨텍스트 메뉴 ==========
export function showContextMenu(e, issueKey, summary) {
  e.preventDefault()
  e.stopPropagation()
  hideContextMenu()

  const menu = document.createElement('div')
  menu.className = 'context-menu'
  // issueKey는 이론상 Jira 응답에서만 오지만 defense-in-depth로 escape
  menu.innerHTML = `
    <div class="context-menu-item" data-ctx="manual-log">이 이슈에 수동 기록</div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" data-ctx="key">이슈 키(${escapeHtml(issueKey)}) 복사</div>
    <div class="context-menu-item" data-ctx="summary">이슈 요약 복사</div>
    <div class="context-menu-item" data-ctx="link">이슈 링크 복사</div>
  `

  document.body.appendChild(menu)

  // 화면 밖으로 나가지 않도록 위치 조정
  const rect = menu.getBoundingClientRect()
  const x = Math.min(e.clientX, window.innerWidth - rect.width - 8)
  const y = Math.min(e.clientY, window.innerHeight - rect.height - 8)
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  state.activeContextMenu = menu

  menu.querySelectorAll('.context-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.ctx
      if (action === 'manual-log') {
        state.showManualLog = { issueKey, summary }
        state.manualIssueCheck = { status: 'ok', key: issueKey, summary }
        hideContextMenu()
        render({ sections: ['modals'] })
        return
      }
      let text = ''
      if (action === 'key') text = issueKey
      else if (action === 'summary') text = summary
      else if (action === 'link') text = getJiraIssueUrl(issueKey) || issueKey
      navigator.clipboard.writeText(text).then(() => {
        showToast('클립보드에 복사되었습니다.', '✓')
      })
      hideContextMenu()
    })
  })

  // 메뉴 외부 클릭/우클릭 시 닫기
  state.contextMenuCloseHandler = () => hideContextMenu()
  setTimeout(() => {
    document.addEventListener('click', state.contextMenuCloseHandler)
    document.addEventListener('contextmenu', state.contextMenuCloseHandler)
  }, 0)
}

export function hideContextMenu() {
  if (state.activeContextMenu) {
    state.activeContextMenu.remove()
    state.activeContextMenu = null
  }
  if (state.contextMenuCloseHandler) {
    document.removeEventListener('click', state.contextMenuCloseHandler)
    document.removeEventListener('contextmenu', state.contextMenuCloseHandler)
    state.contextMenuCloseHandler = null
  }
}
