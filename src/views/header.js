// 헤더 / 탭 / 컨텐츠 / 프로젝트 선택
import { state, PROJECTS } from '../state.js'
import { getSavedUser } from '../auth.js'
import { getProjectFromKey } from '../utils.js'
import { renderIssuesTab } from './issues.js'
import { renderLogsTab } from './logs.js'
import { renderSummaryTab } from './summary.js'

export function renderHeader() {
  return `
    <header class="header">
      <div class="header-left">
        <span class="header-logo">Jira 작업 로그 매니저</span>
      </div>
      <div class="header-right">
        <span class="user-info">${getSavedUser()?.displayName || ''}</span>
        <button class="btn-icon" id="btn-theme" title="테마 전환">
          ${state.theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <button class="btn btn-sm" id="btn-logout">로그아웃</button>
      </div>
    </header>
  `
}

export function renderProjectSelector(isSearchMode = false) {
  // 이슈에서 실제 사용되는 프로젝트 키 추출
  const usedProjectKeys = [...new Set(state.realIssues.map(i => getProjectFromKey(i.key)))]
  const projectList = state.realProjects.length > 0
    ? state.realProjects.filter(p => usedProjectKeys.includes(p.key))
    : PROJECTS.filter(p => p.key !== 'ALL')

  return `
    <div class="project-selector">
      <span class="project-selector-label">프로젝트</span>
      <button class="project-chip ${!isSearchMode && state.currentProject === 'ALL' ? 'active' : ''}" data-project="ALL">전체</button>
      ${projectList.map(p => `
        <button class="project-chip ${!isSearchMode && state.currentProject === p.key ? 'active' : ''}" data-project="${p.key}">
          ${p.name} (${p.key})
        </button>
      `).join('')}
    </div>
  `
}

export function renderTabs() {
  const mainTabs = [
    { id: 'issues', label: '이슈 목록' },
    { id: 'logs', label: '작업 로그 기록' },
    { id: 'summary', label: '요약' },
  ]

  return `
    <div class="tabs-container">
      <div class="main-tabs">
        ${mainTabs.map(tab => `
          <button class="main-tab ${state.currentMainTab === tab.id ? 'active' : ''}" data-main-tab="${tab.id}">
            ${tab.label}
          </button>
        `).join('')}
      </div>
    </div>
  `
}

export function renderContent() {
  switch (state.currentMainTab) {
    case 'issues': return renderIssuesTab()
    case 'logs': return renderLogsTab()
    case 'summary': return renderSummaryTab()
    default: return ''
  }
}
