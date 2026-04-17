// 테마 / 토스트 / 컨텍스트 메뉴
import { state } from './state.js'
import { getJiraIssueUrl } from './utils.js'
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
  render()
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

export function showToast(message, icon = 'ℹ') {
  const container = ensureToastContainer()
  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${message}</span>`
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
  menu.innerHTML = `
    <div class="context-menu-item" data-ctx="manual-log">이 이슈에 수동 기록</div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" data-ctx="key">이슈 키(${issueKey}) 복사</div>
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
        render()
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
