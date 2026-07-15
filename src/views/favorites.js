// 코너 플로팅 즐겨찾기 위젯 (우측 하단)
// 항상 보이는 둥근 버튼(별) + 열렸을 때 버튼 왼쪽에 뜨는 패널.
// 알림 위젯(changelog.js)과 동일한 방식(.corner-fab / .floating-panel)이며 상호 배타 토글.
import { state } from '../state.js'
import { loadFavorites, loadSessions } from '../storage.js'
import { escapeHtml, renderIssueKeyLink, getProjectFromKey } from '../utils.js'

const STAR_SVG = '<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><polygon points="8 1.5 10 6 15 6.6 11.3 10 12.3 14.5 8 12.3 3.7 14.5 4.7 10 1 6.6 6 6"/></svg>'
const CLOSE_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>'

export function renderFavoritesPanel() {
  const favorites = loadFavorites()
  const open = !state.favoritesPanelCollapsed

  // 항상 보이는 플로팅 버튼 (별). 열림 상태면 is-open 강조.
  const button = `
    <button class="corner-fab favorites-fab ${open ? 'is-open' : ''}" data-action="toggle-favorites" aria-expanded="${open}" title="${open ? '즐겨찾기 닫기' : '즐겨찾는 이슈'}">
      ${STAR_SVG}
      ${favorites.length > 0 ? `<span class="corner-fab-badge">${favorites.length}</span>` : ''}
    </button>
  `
  if (!open) return button

  const sessions = loadSessions()
  const sessionMap = new Map(sessions.map(s => [s.issueKey, s.status]))

  const body = favorites.length === 0
    ? `<div class="floating-panel-empty">별표를 눌러 자주 작업하는 이슈를<br>즐겨찾기에 추가하세요.</div>`
    : favorites.map(fav => {
        const status = sessionMap.get(fav.issueKey)
        const btn = status === 'active'
          ? `<button class="btn btn-sm session-active-finish" data-action="finish" data-key="${fav.issueKey}" title="세션 종료"><span class="active-label">진행 중</span><span class="finish-label">종료</span></button>`
          : status === 'paused'
            ? `<button class="btn btn-sm" data-action="fav-start" data-key="${fav.issueKey}" data-summary="${escapeHtml(fav.summary || '')}">재개</button>`
            : `<button class="btn btn-primary btn-sm" data-action="fav-start" data-key="${fav.issueKey}" data-summary="${escapeHtml(fav.summary || '')}">시작</button>`
        return `
          <div class="favorite-item" data-issue-key="${fav.issueKey}" data-issue-summary="${escapeHtml(fav.summary || '')}" data-project="${getProjectFromKey(fav.issueKey)}">
            <div class="favorite-item-info">
              ${renderIssueKeyLink(fav.issueKey)}
              <span class="favorite-summary" title="${escapeHtml(fav.summary || '')}">${escapeHtml(fav.summary || '')}</span>
            </div>
            <div class="favorite-item-actions">
              ${btn}
              <button class="btn-star-remove" data-action="fav-remove" data-key="${fav.issueKey}" title="즐겨찾기 해제">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>
              </button>
            </div>
          </div>
        `
      }).join('')

  const panel = `
    <div class="floating-panel favorites-panel">
      <div class="floating-panel-header">
        <div class="floating-panel-title">
          ${STAR_SVG.replace('width="18" height="18"', 'width="15" height="15"')}
          <span>즐겨찾는 이슈</span>
          ${favorites.length > 0 ? `<span class="floating-panel-count">${favorites.length}</span>` : ''}
        </div>
        <button class="floating-panel-close" data-action="close-favorites" title="닫기" aria-label="닫기">${CLOSE_SVG}</button>
      </div>
      <div class="floating-panel-body">${body}</div>
    </div>
  `
  return button + panel
}
