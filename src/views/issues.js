// 이슈 목록 탭
import { state } from '../state.js'
import { loadSessions, isFavorite } from '../storage.js'
import {
  escapeHtml,
  getStatusCss,
  getShortStatusLabel,
  getStatusInfo,
  getTypeIcon,
  getTypeLabel,
  renderIssueKeyLink,
  getFilteredIssues,
  getProjectIssues,
  getProjectFromKey,
} from '../utils.js'
import { renderProjectSelector } from './header.js'

export function renderIssuesTab() {
  const isSearchMode = state.searchResults !== null
  const sessions = loadSessions()
  const sessionMap = new Map(sessions.map(s => [s.issueKey, s.status]))

  if (state.issuesLoading && !state.issuesLoaded) {
    return `<div class="loading-container">
      <div class="loading-spinner"></div>
      <span class="loading-text">이슈 목록을 불러오는 중</span>
    </div>`
  }

  const projectIssues = getProjectIssues()
  const filters = [
    { id: 'all', label: '전체', count: projectIssues.length },
    { id: 'assignee', label: '할당됨', count: projectIssues.filter(i => i.role === 'assignee').length },
    { id: 'reporter', label: '보고자', count: projectIssues.filter(i => i.role === 'reporter').length },
    { id: 'watcher', label: '워칭', count: projectIssues.filter(i => i.role === 'watcher').length },
  ]

  const filtered = isSearchMode ? state.searchResults : getFilteredIssues()

  return `
    <div class="search-bar">
      <input type="text" class="search-input" id="issue-search" placeholder="이슈 키 검색 (예: 123, DKT-123)" value="${state.searchQuery}" />
      ${state.searchQuery ? `<button class="search-clear" id="search-clear">✕</button>` : ''}
      ${state.searchLoading ? `<span class="search-spinner"></span>` : ''}
    </div>
    ${renderProjectSelector(isSearchMode)}
    <div class="filter-row">
      <div class="filter-tabs">
        ${filters.map(f => `
          <button class="filter-tab ${!isSearchMode && state.currentFilterTab === f.id ? 'active' : ''}" data-filter="${f.id}">
            ${f.label}${!isSearchMode ? `<span class="count">${f.count}</span>` : ''}
          </button>
        `).join('')}
      </div>
      ${!isSearchMode ? `
        <div class="filter-right">
          <label class="closed-toggle">
            <span class="custom-checkbox ${state.showSprintOnly ? 'checked' : ''}">
              <svg viewBox="0 0 12 12" fill="none"><polyline points="2.5 6 5 8.5 9.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
            <input type="checkbox" id="show-sprint-only" ${state.showSprintOnly ? 'checked' : ''} ${state.sprintLoading ? 'disabled' : ''} />
            <span>현재 스프린트만 보기${state.sprintLoading ? ' (불러오는 중...)' : ''}</span>
          </label>
          <label class="closed-toggle">
            <span class="custom-checkbox ${state.showClosedIssues ? 'checked' : ''}">
              <svg viewBox="0 0 12 12" fill="none"><polyline points="2.5 6 5 8.5 9.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
            <input type="checkbox" id="show-closed" ${state.showClosedIssues ? 'checked' : ''} />
            <span>완료/보류 일감 보기</span>
          </label>
          <select class="page-size-select" id="page-size">
            ${[10, 20, 30, 50].map(n => `<option value="${n}" ${state.pageSize === n ? 'selected' : ''}>${n}개씩</option>`).join('')}
          </select>
          <button class="btn btn-sm btn-refresh" id="btn-refresh-issues" ${state.issuesLoading ? 'disabled' : ''} title="이슈 목록 새로고침">
            ${state.issuesLoading ? '<span class="btn-spinner"></span>' : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8A5.5 5.5 0 1 1 12 4.5"/><polyline points="13.5 2 13.5 5 10.5 5"/></svg>'}
          </button>
        </div>
      ` : ''}
    </div>
    ${isSearchMode ? `<div class="search-result-info">검색 결과 ${filtered.length}건</div>` : ''}
    <div class="issue-list ${(isSearchMode || state.currentProject === 'ALL') ? 'show-project-bar' : ''}">
      ${filtered.length === 0 ? `
        <div class="no-session">해당 조건에 맞는 이슈가 없습니다.</div>
      ` : paginateIssues(filtered).map(issue => {
        const statusCss = getStatusCss(issue.statusCategory || issue.status)
        const rawStatus = issue.statusCategory ? issue.status : getStatusInfo(issue.status).label
        const statusLabel = getShortStatusLabel(rawStatus)
        const typeIcon = issue.typeIconUrl
          ? `<img class="issue-type-img" src="${issue.typeIconUrl}" alt="${issue.type}" title="${issue.type}" />`
          : `<span class="issue-type-icon ${issue.type}" title="${getTypeLabel(issue.type)}">${getTypeIcon(issue.type)}</span>`
        const typeLabel = issue.typeIconUrl ? issue.type : getTypeLabel(issue.type)
        return `
        <div class="issue-row" data-issue-key="${issue.key}" data-issue-summary="${escapeHtml(issue.summary || '')}" data-project="${getProjectFromKey(issue.key)}">
          <div class="issue-left">
            ${typeIcon}
            <span class="issue-type-label">${typeLabel}</span>
            ${renderIssueKeyLink(issue.key)}
            <span class="issue-summary">${escapeHtml(issue.summary || '')}</span>
          </div>
          <div class="issue-right">
            <button class="btn-star ${isFavorite(issue.key) ? 'is-favorite' : ''}" data-action="toggle-favorite" data-key="${issue.key}" title="${isFavorite(issue.key) ? '즐겨찾기 해제' : '즐겨찾기 추가'}">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="${isFavorite(issue.key) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="8 1.5 10 6 15 6.6 11.3 10 12.3 14.5 8 12.3 3.7 14.5 4.7 10 1 6.6 6 6"/></svg>
            </button>
            <span class="issue-status ${statusCss}" title="${rawStatus}">${statusLabel}</span>
            ${issue.role && issue.role !== 'none'
              ? `<span class="issue-tag ${issue.role}">${{ assignee: '할당', reporter: '보고', watcher: '워칭' }[issue.role]}</span>`
              : `<span class="issue-tag placeholder" aria-hidden="true">·</span>`
            }
            <button class="btn btn-sm btn-manual-inline" data-action="manual-log" data-key="${issue.key}" title="수동 기록">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><polyline points="8 4.5 8 8 10.5 9.5"/></svg>
            </button>
            ${sessionMap.get(issue.key) === 'active'
              ? `<button class="btn btn-sm btn-start session-active-finish" data-action="finish" data-key="${issue.key}" title="세션 종료"><span class="active-label">진행 중</span><span class="finish-label">종료</span></button>`
              : sessionMap.has(issue.key)
                ? `<button class="btn btn-sm btn-start" data-action="start" data-key="${issue.key}">재개</button>`
                : `<button class="btn btn-primary btn-sm btn-start" data-action="start" data-key="${issue.key}">시작</button>`
            }
          </div>
        </div>
        `
      }).join('')}
    </div>
    ${!isSearchMode ? renderPagination(filtered.length) : ''}
  `
}

export function paginateIssues(issues) {
  const start = (state.currentPage - 1) * state.pageSize
  return issues.slice(start, start + state.pageSize)
}

export function renderPagination(totalItems) {
  const totalPages = Math.ceil(totalItems / state.pageSize)
  if (totalPages <= 1) return ''

  const pages = []
  for (let i = 1; i <= totalPages; i++) {
    // 처음, 마지막, 현재 주변 2페이지만 표시
    if (i === 1 || i === totalPages || (i >= state.currentPage - 2 && i <= state.currentPage + 2)) {
      pages.push(i)
    } else if (pages[pages.length - 1] !== '...') {
      pages.push('...')
    }
  }

  return `
    <div class="pagination">
      <button class="btn btn-sm" data-page="${state.currentPage - 1}" ${state.currentPage <= 1 ? 'disabled' : ''}>◀</button>
      ${pages.map(p => p === '...'
        ? `<span class="pagination-dots">...</span>`
        : `<button class="btn btn-sm ${p === state.currentPage ? 'btn-primary' : ''}" data-page="${p}">${p}</button>`
      ).join('')}
      <button class="btn btn-sm" data-page="${state.currentPage + 1}" ${state.currentPage >= totalPages ? 'disabled' : ''}>▶</button>
      <span class="pagination-info">${totalItems}건</span>
    </div>
  `
}
