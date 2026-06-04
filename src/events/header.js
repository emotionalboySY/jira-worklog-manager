// 헤더 영역 + 이슈 목록 도구바 이벤트.
// 테마/로그아웃/검색/완료보기/스프린트보기/페이지 사이즈/새로고침 + 일감 미지정 작업 시작.
import { state, NO_ISSUE_KEY, NO_ISSUE_SUMMARY, resetInMemoryUserData } from '../state.js'
import { logout } from '../auth.js'
import { fetchActiveSprintIssueKeys } from '../jira.js'
import { addSession, loadSessions } from '../storage.js'
import { toggleTheme, showToast } from '../ui.js'
import {
  refreshIssues,
  refreshWorklogs,
  performSearch,
} from '../actions.js'
import { render, resetIssueListScroll } from '../render.js'
import { openCreateIssueModal } from './create.js'
import { stopSessionPolling } from '../sessionSync.js'
import { clearTransitionCatalog } from '../transitionCatalog.js'
import { on } from './_dom.js'

// 검색 발화 — Enter 또는 검색 버튼 클릭 시에만 호출. 비어 있으면 검색 모드 종료.
function triggerIssueSearch() {
  const q = (state.searchQuery || '').trim()
  if (!q) {
    clearIssueSearch()
    return
  }
  performSearch()
}

function clearIssueSearch() {
  state.searchQuery = ''
  state.searchResults = null
  state.searchLoading = false
  render()
  resetIssueListScroll()
}

export function bindHeaderEvents() {
  // 테마 토글
  const themeBtn = document.getElementById('btn-theme')
  if (themeBtn) {
    on(themeBtn, 'click', toggleTheme)
  }

  // 로그아웃
  const logoutBtn = document.getElementById('btn-logout')
  if (logoutBtn) {
    on(logoutBtn, 'click', () => {
      logout()
      // 세션 백엔드 폴링 중단 + 직전 사용자의 in-memory 데이터(이슈/워크로그/캐시) 정리
      try { stopSessionPolling() } catch {}
      try { resetInMemoryUserData() } catch {}
      try { clearTransitionCatalog() } catch {}
      render()
    })
  }

  // 이슈 목록 새로고침
  const refreshIssuesBtn = document.getElementById('btn-refresh-issues')
  if (refreshIssuesBtn) {
    on(refreshIssuesBtn, 'click', () => refreshIssues())
  }

  // 새 일감 생성 모달 열기
  const createIssueBtn = document.getElementById('btn-create-issue')
  if (createIssueBtn) {
    on(createIssueBtn, 'click', openCreateIssueModal)
  }

  // 작업 로그 새로고침
  const refreshWorklogsBtn = document.getElementById('btn-refresh-worklogs')
  if (refreshWorklogsBtn) {
    on(refreshWorklogsBtn, 'click', () => refreshWorklogs())
  }

  // 이슈 검색 — 실시간 자동 검색 X. Enter 또는 검색 버튼 클릭 시에만 검색 발화.
  const searchInput = document.getElementById('issue-search')
  if (searchInput) {
    on(searchInput, 'input', (e) => {
      state.searchQuery = e.target.value
    })
    on(searchInput, 'compositionend', (e) => {
      state.searchQuery = e.target.value
    })
    on(searchInput, 'keydown', (e) => {
      if (e.isComposing) return
      if (e.key === 'Enter') {
        e.preventDefault()
        triggerIssueSearch()
      } else if (e.key === 'Escape') {
        clearIssueSearch()
      }
    })
  }

  const searchSubmitBtn = document.getElementById('search-submit')
  if (searchSubmitBtn) {
    on(searchSubmitBtn, 'click', triggerIssueSearch)
  }

  const searchClearBtn = document.getElementById('search-clear')
  if (searchClearBtn) {
    on(searchClearBtn, 'click', () => {
      clearIssueSearch()
      document.getElementById('issue-search')?.focus()
    })
  }

  // 검색 결과 모드의 "내 이슈 목록으로 돌아가기" 링크
  const searchBackLink = document.getElementById('search-mode-back')
  if (searchBackLink) {
    on(searchBackLink, 'click', (e) => {
      e.preventDefault()
      clearIssueSearch()
    })
  }

  // 완료/보류 토글
  const showClosedCheckbox = document.getElementById('show-closed')
  if (showClosedCheckbox) {
    on(showClosedCheckbox, 'change', (e) => {
      state.showClosedIssues = e.target.checked
      state.currentPage = 1
      render()
      resetIssueListScroll()
    })
  }

  // 현재 스프린트만 보기 토글
  const showSprintOnlyCheckbox = document.getElementById('show-sprint-only')
  if (showSprintOnlyCheckbox) {
    on(showSprintOnlyCheckbox, 'change', async (e) => {
      state.showSprintOnly = e.target.checked
      state.currentPage = 1
      if (state.showSprintOnly && state.activeSprintKeys === null) {
        state.sprintLoading = true
        render()
        try {
          const keys = await fetchActiveSprintIssueKeys()
          state.activeSprintKeys = new Set(keys)
        } catch (err) {
          console.error('스프린트 이슈 조회 실패:', err)
          state.activeSprintKeys = new Set()
          showToast('스프린트 이슈를 불러오지 못했습니다.', '⚠')
        }
        state.sprintLoading = false
      }
      render()
      resetIssueListScroll()
    })
  }

  // 페이지 사이즈
  const pageSizeSelect = document.getElementById('page-size')
  if (pageSizeSelect) {
    on(pageSizeSelect, 'change', (e) => {
      state.pageSize = parseInt(e.target.value, 10)
      state.currentPage = 1
      render()
      resetIssueListScroll()
    })
  }

  // 일감 없이 작업 시작하기 (세션 목록이 비어있을 때만 노출)
  const startNoIssueBtn = document.getElementById('btn-start-no-issue')
  if (startNoIssueBtn) {
    on(startNoIssueBtn, 'click', () => {
      // 진행 중 세션이 전혀 없을 때만 이 버튼이 노출되지만, 방어적으로 한 번 더 확인
      const sessions = loadSessions()
      if (sessions.some(s => s.issueKey === NO_ISSUE_KEY)) {
        showToast('이미 일감 미지정 세션이 진행 중입니다.', 'ℹ')
        return
      }
      addSession(NO_ISSUE_KEY, NO_ISSUE_SUMMARY)
      showToast('일감 미지정 작업을 시작했습니다. 종료 시 이슈를 지정해주세요.', '✓')
      render()
    })
  }
}
