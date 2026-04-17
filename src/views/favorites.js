// 플로팅 즐겨찾기 패널 (우측 고정)
import { state } from '../state.js'
import { loadFavorites, loadSessions } from '../storage.js'
import { escapeHtml, renderIssueKeyLink } from '../utils.js'

export function renderFavoritesPanel() {
  const favorites = loadFavorites()
  const sessions = loadSessions()
  const sessionMap = new Map(sessions.map(s => [s.issueKey, s.status]))

  if (state.favoritesPanelCollapsed) {
    return `
      <div class="favorites-panel collapsed">
        <button class="favorites-toggle" id="favorites-toggle" title="즐겨찾는 이슈 펼치기">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><polygon points="8 1.5 10 6 15 6.6 11.3 10 12.3 14.5 8 12.3 3.7 14.5 4.7 10 1 6.6 6 6"/></svg>
          ${favorites.length > 0 ? `<span class="favorites-count">${favorites.length}</span>` : ''}
        </button>
      </div>
    `
  }

  const body = favorites.length === 0
    ? `<div class="favorites-empty">별표를 눌러 자주 작업하는 이슈를<br>즐겨찾기에 추가하세요.</div>`
    : favorites.map(fav => {
        const status = sessionMap.get(fav.issueKey)
        const btn = status === 'active'
          ? `<button class="btn btn-sm session-active-finish" data-action="finish" data-key="${fav.issueKey}" title="세션 종료"><span class="active-label">진행 중</span><span class="finish-label">종료</span></button>`
          : status === 'paused'
            ? `<button class="btn btn-sm" data-action="fav-start" data-key="${fav.issueKey}" data-summary="${escapeHtml(fav.summary || '')}">재개</button>`
            : `<button class="btn btn-primary btn-sm" data-action="fav-start" data-key="${fav.issueKey}" data-summary="${escapeHtml(fav.summary || '')}">시작</button>`
        return `
          <div class="favorite-item" data-issue-key="${fav.issueKey}" data-issue-summary="${escapeHtml(fav.summary || '')}">
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

  return `
    <div class="favorites-panel expanded">
      <div class="favorites-header">
        <div class="favorites-title">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><polygon points="8 1.5 10 6 15 6.6 11.3 10 12.3 14.5 8 12.3 3.7 14.5 4.7 10 1 6.6 6 6"/></svg>
          <span>즐겨찾는 이슈</span>
          ${favorites.length > 0 ? `<span class="favorites-count-inline">${favorites.length}</span>` : ''}
        </div>
        <button class="favorites-collapse-btn" id="favorites-toggle" title="접기">▸</button>
      </div>
      <div class="favorites-body">${body}</div>
    </div>
  `
}
