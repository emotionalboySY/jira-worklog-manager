// 이슈 목록 탭
import { state } from '../state.js'
import { loadSessions, isFavorite } from '../storage.js'
import { getFlashState } from '../issueFlash.js'
import {
  escapeHtml,
  getStatusCss,
  getShortStatusLabel,
  getStatusInfo,
  getTypeIcon,
  getTypeLabel,
  renderIssueKeyLink,
  renderParentLink,
  getFilteredIssues,
  getProjectIssues,
  getProjectFromKey,
  getSelectableProjects,
  groupBacklogBySprint,
} from '../utils.js'
import { renderProjectSelector } from './header.js'

export function renderIssuesTab() {
  const sessions = loadSessions()
  const sessionMap = new Map(sessions.map(s => [s.issueKey, s.status]))
  const viewToggle = renderViewModeToggle()

  // 배포 예정(백로그) 뷰 — 선택 프로젝트의 완료 안 된 일감을 스프린트/백로그로 구분
  if (state.issueViewMode === 'backlog') {
    return viewToggle + renderBacklogView(sessionMap)
  }

  // ----- 내 일감 뷰 -----
  const isSearchMode = state.searchResults !== null

  if (state.issuesLoading && !state.issuesLoaded) {
    return viewToggle + `<div class="loading-container">
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
  const selectedCount = state.selectedIssues.size
  const hasSelection = selectedCount > 0

  // 검색 모드/검색 중일 때 표시되는 상태 박스 (프로젝트 필터/내 역할 필터 자리 대체).
  // 검색 중에는 스피너 + "검색 중..." / 완료 후에는 복귀 안내 링크.
  const showStatusBox = isSearchMode || state.searchLoading
  const statusBoxHtml = showStatusBox ? `
    <div class="search-mode-notice">
      ${state.searchLoading
        ? `<span class="search-spinner"></span><span>검색 중...</span>`
        : `<span>현재 검색 결과를 보고 있습니다. </span><a href="#" class="search-mode-back" id="search-mode-back">내 이슈 목록으로 돌아가려면 클릭하기</a>`}
    </div>
  ` : ''

  return viewToggle + `
    <div class="search-bar">
      <div class="search-input-wrap">
        <input type="text" class="search-input" id="issue-search" placeholder="이슈 키 또는 요약 검색 (예: DKT-123, 키워드)" value="${escapeHtml(state.searchQuery || '')}" />
        ${state.searchQuery ? `<button class="search-clear" id="search-clear" type="button" aria-label="검색어 지우기" title="검색어 지우기">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        </button>` : ''}
      </div>
      <button class="search-submit" id="search-submit" type="button" title="검색" aria-label="검색"${state.searchLoading ? ' disabled' : ''}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/></svg>
        <span>검색</span>
      </button>
    </div>
    ${showStatusBox ? statusBoxHtml : renderProjectSelector(false)}
    ${showStatusBox ? '' : `
      <div class="filter-row">
        <div class="filter-tabs">
          ${filters.map(f => `
            <button class="filter-tab ${state.currentFilterTab === f.id ? 'active' : ''}" data-filter="${f.id}">
              ${f.label}<span class="count">${f.count}</span>
            </button>
          `).join('')}
        </div>
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
          <button class="btn btn-primary btn-sm" id="btn-create-issue" title="새 일감 생성">+ 새 일감</button>
        </div>
      </div>
    `}
    ${isSearchMode ? `
      <div class="search-result-info">
        <span>검색 결과 ${filtered.length}건</span>
        <select class="page-size-select" id="page-size">
          ${[10, 20, 30, 50].map(n => `<option value="${n}" ${state.pageSize === n ? 'selected' : ''}>${n}개씩</option>`).join('')}
        </select>
      </div>
    ` : ''}
    ${hasSelection ? renderBulkCopyBar(selectedCount) : ''}
    <div class="issue-list ${(isSearchMode || state.currentProject === 'ALL') ? 'show-project-bar' : ''} ${hasSelection ? 'has-selection' : ''}">
      ${filtered.length === 0 ? `
        <div class="no-session">해당 조건에 맞는 이슈가 없습니다.</div>
      ` : paginateIssues(filtered).map(issue => renderIssueRow(issue, sessionMap)).join('')}
    </div>
    ${renderPagination(filtered.length)}
  `
}

// 이슈 한 행 렌더링 — 내 일감 뷰와 백로그 뷰가 공유한다.
function renderIssueRow(issue, sessionMap) {
  const statusCss = getStatusCss(issue.statusCategory || issue.status)
  const rawStatus = issue.statusCategory ? issue.status : getStatusInfo(issue.status).label
  const statusLabel = getShortStatusLabel(rawStatus)
  const typeIcon = issue.typeIconUrl
    ? `<img class="issue-type-img" src="${issue.typeIconUrl}" alt="${issue.type}" title="${issue.type}" />`
    : `<span class="issue-type-icon ${issue.type}" title="${getTypeLabel(issue.type)}">${getTypeIcon(issue.type)}</span>`
  const typeLabel = issue.typeIconUrl ? issue.type : getTypeLabel(issue.type)
  const isSelected = state.selectedIssues.has(issue.key)
  // 외부 변경으로 강조 중인 행: 클래스 + 경과시간(음수 delay)으로 애니메이션 이어붙임
  const flash = getFlashState(issue.key)
  return `
        <div class="issue-row ${isSelected ? 'is-selected' : ''}${flash ? ' issue-flash' : ''}" data-issue-key="${issue.key}" data-issue-summary="${escapeHtml(issue.summary || '')}" data-project="${getProjectFromKey(issue.key)}"${flash ? ` style="--flash-delay:-${flash.delayMs}ms"` : ''}>
          <span class="issue-select" data-action="toggle-select" data-key="${issue.key}" title="선택">
            <input type="checkbox" ${isSelected ? 'checked' : ''} tabindex="-1" />
          </span>
          <div class="issue-left">
            ${typeIcon}
            <span class="issue-type-label">${typeLabel}</span>
            ${renderIssueKeyLink(issue.key)}
            <span class="issue-summary">${escapeHtml(issue.summary || '')}</span>
          </div>
          <div class="issue-right">
            ${renderParentLink(issue.parent)}
            <button class="btn-star ${isFavorite(issue.key) ? 'is-favorite' : ''}" data-action="toggle-favorite" data-key="${issue.key}" title="${isFavorite(issue.key) ? '즐겨찾기 해제' : '즐겨찾기 추가'}">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="${isFavorite(issue.key) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="8 1.5 10 6 15 6.6 11.3 10 12.3 14.5 8 12.3 3.7 14.5 4.7 10 1 6.6 6 6"/></svg>
            </button>
            ${renderStatusButton(issue, statusCss, statusLabel, rawStatus)}
            ${renderAssigneeAvatar(issue.assignee, issue.key)}
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
}

// ===== 뷰 모드 전환 (내 일감 ↔ 배포 예정) =====
function renderViewModeToggle() {
  const mode = state.issueViewMode
  return `
    <div class="view-mode-toggle" role="tablist" aria-label="이슈 보기 방식">
      <button class="view-mode-btn ${mode === 'mine' ? 'active' : ''}" data-view-mode="mine" role="tab" aria-selected="${mode === 'mine'}">내 일감</button>
      <button class="view-mode-btn ${mode === 'backlog' ? 'active' : ''}" data-view-mode="backlog" role="tab" aria-selected="${mode === 'backlog'}">배포 예정 (백로그)</button>
    </div>
  `
}

// ===== 배포 예정(백로그) 뷰 =====
function renderBacklogView(sessionMap) {
  const projects = getSelectableProjects()
  const selected = state.backlogProject

  const refreshIcon = state.backlogLoading
    ? '<span class="btn-spinner"></span>'
    : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8A5.5 5.5 0 1 1 12 4.5"/><polyline points="13.5 2 13.5 5 10.5 5"/></svg>'

  const projectBar = `
    <div class="project-selector backlog-project-selector">
      <span class="project-selector-label">프로젝트</span>
      ${projects.length === 0
        ? `<span class="backlog-hint">불러온 프로젝트가 없습니다.</span>`
        : projects.map(p => `
          <button class="project-chip backlog-project-chip ${selected === p.key ? 'active' : ''}" data-backlog-project="${escapeHtml(p.key)}">
            ${escapeHtml(p.name)} (${escapeHtml(p.key)})
          </button>
        `).join('')}
      <button class="btn btn-sm btn-refresh backlog-refresh" data-action="refresh-backlog" ${state.backlogLoading || !selected ? 'disabled' : ''} title="백로그 새로고침">
        ${refreshIcon}
      </button>
    </div>
  `

  let body
  if (!selected) {
    body = `<div class="no-session">배포 일감을 확인할 프로젝트를 선택하세요.</div>`
  } else if (state.backlogLoading && !state.backlogLoaded) {
    body = `<div class="loading-container">
      <div class="loading-spinner"></div>
      <span class="loading-text">${escapeHtml(selected)} 백로그를 불러오는 중</span>
    </div>`
  } else if (state.backlogError) {
    body = `<div class="no-session">${escapeHtml(state.backlogError)}</div>`
  } else {
    body = renderBacklogGroups(sessionMap)
  }

  const selectedCount = state.selectedIssues.size
  return `
    ${projectBar}
    ${selectedCount > 0 ? renderBulkCopyBar(selectedCount) : ''}
    ${body}
  `
}

// 스프린트 시작/종료일을 'M/D~M/D' 축약으로. 값이 없으면 빈 문자열.
function formatSprintDates(s) {
  const fmt = (iso) => {
    if (!iso) return ''
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    return `${d.getMonth() + 1}/${d.getDate()}`
  }
  const a = fmt(s.startDate)
  const b = fmt(s.endDate)
  if (a && b) return `${a}~${b}`
  return a || b || ''
}

function renderBacklogGroups(sessionMap) {
  const issues = state.backlogIssues
  if (!issues || issues.length === 0) {
    return `<div class="no-session">완료되지 않은 일감이 없습니다.</div>`
  }
  const { sections, backlog } = groupBacklogBySprint(issues)

  const renderGroup = (titleHtml, badgeHtml, groupIssues, extraClass = '') => `
    <div class="backlog-group ${extraClass}">
      <div class="backlog-group-header">
        <span class="backlog-group-title">${titleHtml}</span>
        ${badgeHtml || ''}
        <span class="backlog-group-count">${groupIssues.length}건</span>
      </div>
      <div class="issue-list show-project-bar">
        ${groupIssues.length === 0
          ? `<div class="backlog-empty">일감 없음</div>`
          : groupIssues.map(iss => renderIssueRow(iss, sessionMap)).join('')}
      </div>
    </div>
  `

  const sprintSections = sections.map(sec => {
    const s = sec.sprint
    const stateBadge = s.state === 'active'
      ? `<span class="sprint-state-badge active">진행 중</span>`
      : s.state === 'future'
        ? `<span class="sprint-state-badge future">예정</span>`
        : ''
    const dates = formatSprintDates(s)
    const title = `${escapeHtml(s.name)}${dates ? ` <span class="sprint-dates">${dates}</span>` : ''}`
    return renderGroup(title, stateBadge, sec.issues, 'is-sprint')
  }).join('')

  const backlogBadge = `<span class="sprint-state-badge backlog">스프린트 미포함</span>`
  return `
    <div class="backlog-groups">
      ${sprintSections}
      ${renderGroup('백로그', backlogBadge, backlog, 'is-backlog')}
    </div>
  `
}

// 일괄 복사 액션 바 — 1개 이상 선택 시 이슈 목록 위에 sticky로 노출
function renderBulkCopyBar(count) {
  return `
    <div class="bulk-copy-bar">
      <span class="bulk-copy-count">${count}개 선택됨</span>
      <div class="bulk-copy-actions">
        <button class="btn btn-sm" data-bulk="key" title="이슈 키만 콤마로 구분해 복사">키만</button>
        <button class="btn btn-sm" data-bulk="both" title="이슈 키와 요약을 한 줄씩 복사">키 + 요약</button>
        <button class="btn btn-sm" data-bulk="summary" title="이슈 요약만 한 줄씩 복사">요약만</button>
        <button class="btn btn-sm bulk-copy-clear" data-bulk="clear" title="선택 해제 (Esc)" aria-label="선택 해제">✕</button>
      </div>
    </div>
  `
}

// 상태 버튼 — 클릭 시 전이 드롭다운 토글. statusTransitioning에 이슈 키가 있으면
// 스피너 + disabled. 이슈별 독립 로딩이라 다른 이슈 버튼은 영향받지 않음.
function renderStatusButton(issue, statusCss, statusLabel, rawStatus) {
  const isLoading = state.statusTransitioning.has(issue.key)
  if (isLoading) {
    return `<button type="button" class="issue-status ${statusCss} is-loading" disabled aria-label="상태 변경 중"><span class="btn-spinner"></span></button>`
  }
  const titleSafe = escapeHtml(rawStatus || '-')
  const currentStatusAttr = escapeHtml(issue.status || '')
  return `<button type="button" class="issue-status ${statusCss}" data-action="toggle-status-menu" data-key="${issue.key}" data-current-status="${currentStatusAttr}" title="${titleSafe} · 클릭하여 상태 변경">${statusLabel}</button>`
}

// 담당자 원형 프로필. 클릭 시 담당자 변경 드롭다운이 열림.
// - 업데이트 중(assigneeUpdating에 키가 있음)이면 스피너로 교체
// - 미할당이면 SVG 실루엣 기본 아이콘
function renderAssigneeAvatar(assignee, issueKey) {
  const isUpdating = state.assigneeUpdating.has(issueKey)
  if (isUpdating) {
    return `
      <span class="assignee-avatar assignee-avatar-loading" title="담당자 변경 중" aria-label="담당자 변경 중">
        <span class="btn-spinner"></span>
      </span>
    `
  }
  const clickAttrs = `data-action="toggle-assignee-menu" data-issue-key="${escapeHtml(issueKey)}" role="button" tabindex="0"`
  if (assignee && assignee.avatarUrl) {
    const title = escapeHtml(assignee.displayName || '담당자')
    return `<img class="assignee-avatar" src="${escapeHtml(assignee.avatarUrl)}" alt="${title}" title="${title} · 클릭하여 변경" loading="lazy" onerror="this.classList.add('broken')" ${clickAttrs} />`
  }
  return `
    <span class="assignee-avatar assignee-avatar-empty" title="미할당 · 클릭하여 지정" aria-label="미할당" ${clickAttrs}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="8" r="3.5"/>
        <path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6"/>
      </svg>
    </span>
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
