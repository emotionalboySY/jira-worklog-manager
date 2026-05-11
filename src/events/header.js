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
import { on } from './_dom.js'

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
      // 직전 사용자의 in-memory 데이터(이슈/워크로그/캐시) 정리
      try { resetInMemoryUserData() } catch {}
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

  // 이슈 검색
  // IME 조합(한글 등) 중에는 검색 발화를 보류 — compositionend 시점에 한 번만 발화.
  const searchInput = document.getElementById('issue-search')
  if (searchInput) {
    let debounceTimer
    let composing = false
    const triggerSearch = () => {
      clearTimeout(debounceTimer)
      if (!state.searchQuery.trim()) {
        state.searchResults = null
        state.searchLoading = false
        render()
        resetIssueListScroll()
        document.getElementById('issue-search')?.focus()
        return
      }
      debounceTimer = setTimeout(() => performSearch(), 500)
    }
    on(searchInput, 'input', (e) => {
      state.searchQuery = e.target.value
      // IME 조합 중에는 부분 발화 방지
      if (composing || e.isComposing) return
      triggerSearch()
    })
    on(searchInput, 'compositionstart', () => { composing = true })
    on(searchInput, 'compositionend', (e) => {
      composing = false
      state.searchQuery = e.target.value
      triggerSearch()
    })
    on(searchInput, 'keydown', (e) => {
      if (e.isComposing) return
      if (e.key === 'Enter') {
        clearTimeout(debounceTimer)
        performSearch()
      }
      if (e.key === 'Escape') {
        state.searchQuery = ''
        state.searchResults = null
        render()
        resetIssueListScroll()
      }
    })
  }

  const searchClearBtn = document.getElementById('search-clear')
  if (searchClearBtn) {
    on(searchClearBtn, 'click', () => {
      state.searchQuery = ''
      state.searchResults = null
      render()
      resetIssueListScroll()
      document.getElementById('issue-search')?.focus()
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
