// 전체 이벤트 바인딩 + 타이머 업데이트
import flatpickr from 'flatpickr'
import { Korean } from 'flatpickr/dist/l10n/ko.js'
import { state, NO_ISSUE_KEY, NO_ISSUE_SUMMARY, resetInMemoryUserData } from './state.js'
import { logout, isLoggedIn } from './auth.js'
import {
  fetchIssueMeta,
  fetchActiveSprintIssueKeys,
  createWorklog,
  updateWorklog,
  deleteWorklog,
  fetchTransitions,
  fetchAttachmentBlobUrl,
  fetchIssueTypes,
  searchIssuesByKey,
  getCachedTransitions,
  setCachedTransitions,
  getCachedAssignableUsers,
  getCachedIssueTypes,
  setCachedIssueTypes,
} from './jira.js'
import {
  getEditorOnMount, runCommandOnEditor,
} from './tiptap.js'
import {
  loadSessions,
  saveSessions,
  addSession,
  pauseSession,
  resumeSession,
  removeSession,
  deleteSessionSegment,
  swapSessionIssue,
  setDayOff,
  toggleFavorite,
  savePreferences,
  resetPreferences,
} from './storage.js'
import {
  toDateString,
  shiftDate,
  formatMinutes,
  getActiveIssues,
  getActiveLogs,
  buildWorklogSegments,
  formatJiraError,
  formatLunchRange,
  getProjectKeysOrFallback,
  withSpinner,
} from './utils.js'
import { toggleTheme, showToast, showContextMenu, applyPreferences } from './ui.js'
import {
  loadWorklogs,
  ensureMonthWorklogsLoaded,
  refreshIssues,
  refreshWorklogs,
  performSearch,
} from './actions.js'
import {
  isValidIssueKeyFormat,
  findLoadedIssue,
  getLatestEndTimeForDate,
  invalidateWorklogMonth,
  updateManualDurationReadout,
  updateEditDurationReadout,
  updateFinishDurationReadouts,
  computeDurationFromTimes,
  renderManualKeyHint,
  selectManualKeyCandidate,
  updateManualKeyDropdown,
  MANUAL_KEY_CTX,
  FINISH_KEY_CTX,
  SWAP_KEY_CTX,
  renderKeyHint,
  updateKeyDropdown,
  selectKeyCandidate,
  buildTransitionFieldsPayload,
} from './views/modals.js'
import { ensureSummaryWorklogs } from './views/summary.js'
import { render, resetIssueListScroll } from './render.js'

import { on } from './events/_dom.js'
import {
  registerClickAction,
  registerClickData,
  registerClickSelector,
  registerContextMenu,
  installGlobalDelegation,
} from './events/_delegate.js'
import {
  openCreateIssueModal,
  closeCreateIssueModal,
  ensureCreateIssueEditor,
  bindCreateIssueEvents,
} from './events/create.js'
import {
  bindCommentEvents,
  ensureCommentEditors,
  cancelCommentCompose,
  cancelEditComment,
} from './events/comments.js'
import {
  closeIssueDetailModal,
  enterIssueDetailEditMode,
  cancelIssueDetailEdit,
  saveIssueDetailEdit,
  enterSummaryEdit,
  cancelSummaryEdit,
  saveSummaryEdit,
  ensureIssueDetailEditor,
  openIssueDetailModal,
} from './events/detail.js'
import {
  closeAssigneeDropdown,
  refreshAssigneeDropdownList,
  loadAssignableUsers,
  applyAssigneeChange,
  performTypeChange,
  performTransition,
} from './events/dropdowns.js'
import { closeSettings, deriveProjectColors } from './events/settings.js'

// ESC 키로 가장 위(나중에 열린) 모달 닫기.
// 오버레이 바깥 클릭 닫기는 textarea 드래그 선택이 밖에서 끝날 때 오탐하므로 제거.
// 취소/X 버튼과 ESC로만 닫는다.
let globalKeyListenerRegistered = false
let globalClickListenerRegistered = false

// 이슈 키 자동완성 드롭다운의 키보드 네비게이션 핸들러.
// finish-issue-key / swap-issue-key / manual-issue-key 세 곳이 동일 구조라 헬퍼로 통합.
// ctx: { dropdownId, activeIdxKey, selectCtx }  (selectCtx = selectKeyCandidate에 넘길 ctx)
function bindKeyDropdownNav(input, ctx) {
  on(input, 'keydown', (e) => {
    const dropdown = document.getElementById(ctx.dropdownId)
    if (!dropdown || dropdown.style.display === 'none') return
    const items = dropdown.querySelectorAll('.autocomplete-item')
    if (items.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      state[ctx.activeIdxKey] = (state[ctx.activeIdxKey] + 1) % items.length
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      state[ctx.activeIdxKey] = (state[ctx.activeIdxKey] - 1 + items.length) % items.length
    } else if (e.key === 'Enter' && !(e.ctrlKey || e.metaKey)) {
      // Enter만 누르면 드롭다운 선택, Ctrl+Enter는 제출 (전역 핸들러로 위임)
      if (state[ctx.activeIdxKey] >= 0) {
        e.preventDefault()
        const el = items[state[ctx.activeIdxKey]]
        selectKeyCandidate(ctx.selectCtx, el.dataset.key, el.dataset.summary || '')
        return
      }
    } else if (e.key === 'Escape') {
      state[ctx.activeIdxKey] = -1
      dropdown.style.display = 'none'
      dropdown.innerHTML = ''
      return
    } else {
      return
    }
    items.forEach((el, i) => el.classList.toggle('active', i === state[ctx.activeIdxKey]))
    if (state[ctx.activeIdxKey] >= 0) items[state[ctx.activeIdxKey]].scrollIntoView({ block: 'nearest' })
  })
}

// 즐겨찾기 패널을 닫힘 애니메이션과 함께 접기.
// .is-closing 클래스로 역방향 애니메이션을 재생한 뒤 animationend에서 재렌더.
function closeFavoritesPanel() {
  if (state.favoritesPanelCollapsed) return
  const panel = document.querySelector('.favorites-panel.expanded')
  if (!panel || panel.classList.contains('is-closing')) {
    state.favoritesPanelCollapsed = true
    localStorage.setItem('favorites_collapsed', '1')
    render({ sections: ['favorites'] })
    return
  }
  panel.classList.add('is-closing')
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    state.favoritesPanelCollapsed = true
    localStorage.setItem('favorites_collapsed', '1')
    render({ sections: ['favorites'] })
  }
  panel.addEventListener('animationend', finish, { once: true })
  // 안전장치: animationend가 발화하지 못하더라도 반드시 상태 전환
  setTimeout(finish, 220)
}

// 즐겨찾기 패널이 펼쳐져 있을 때 패널 바깥을 클릭하면 접기 (애니메이션 포함).
// 이슈 목록의 star/시작/수동기록 버튼은 stopPropagation을 호출하므로 여기로 전파되지 않아
// 패널이 열린 상태에서 별을 눌러 즐겨찾기를 추가/해제해도 패널은 유지된다.
function handleGlobalClick(e) {
  // 상태 드롭다운: 드롭다운 바깥 + 상태 버튼 바깥을 클릭하면 닫음
  if (state.statusDropdown) {
    const dd = document.getElementById('status-dropdown')
    const clickedOnTrigger = e.target.closest?.('[data-action="toggle-status-menu"]')
    if (dd && !dd.contains(e.target) && !clickedOnTrigger) {
      state.statusDropdown = null
      render({ sections: ['modals'] })
    }
  }

  // 담당자 드롭다운: 드롭다운 바깥 + 아바타 바깥 클릭 시 닫음
  if (state.assigneeDropdown) {
    const dd = document.getElementById('assignee-dropdown')
    const clickedOnTrigger = e.target.closest?.('[data-action="toggle-assignee-menu"]')
    if (dd && !dd.contains(e.target) && !clickedOnTrigger) {
      closeAssigneeDropdown()
    }
  }

  // 이슈 유형 드롭다운: 드롭다운 바깥 + 트리거 바깥 클릭 시 닫음
  if (state.typeDropdown) {
    const dd = document.getElementById('type-dropdown')
    const clickedOnTrigger = e.target.closest?.('[data-action="toggle-type-menu"]')
    if (dd && !dd.contains(e.target) && !clickedOnTrigger) {
      state.typeDropdown = null
      render({ sections: ['modals'] })
    }
  }

  if (state.favoritesPanelCollapsed) return
  const panel = document.querySelector('.favorites-panel.expanded')
  if (!panel) return
  if (panel.contains(e.target)) return
  closeFavoritesPanel()
}

function handleGlobalKeydown(e) {
  // Ctrl/Cmd + Enter → 최상단 모달의 주 액션(Jira 기록 등) 트리거
  // textarea에서도 작동해야 하므로 전역에서 가로챈다
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    // 우선순위: 가장 나중에 열린 모달 우선
    let submitBtn = null
    if (state.transitionFieldsModal) submitBtn = document.getElementById('transition-fields-submit')
    else if (state.showSwapIssue) submitBtn = document.getElementById('swap-issue-submit')
    else if (state.editingWorklog) submitBtn = document.getElementById('edit-worklog-submit')
    else if (state.showManualLog) submitBtn = document.getElementById('manual-log-submit')
    else if (state.showCreateIssue) submitBtn = document.getElementById('create-issue-submit')
    else if (state.issueDetailModal?.editing) submitBtn = document.getElementById('issue-detail-edit-save')
    else if (state.showModal) submitBtn = document.getElementById('modal-submit')
    if (submitBtn && !submitBtn.disabled) {
      e.preventDefault()
      submitBtn.click()
    }
    return
  }
  if (e.key !== 'Escape') return
  const modalsOnly = { sections: ['modals'] }
  if (state.transitionFieldsModal) {
    if (state.transitionFieldsModal.submitting) return
    state.transitionFieldsModal = null
    render(modalsOnly)
    return
  }
  if (state.statusDropdown) {
    state.statusDropdown = null
    render(modalsOnly)
    return
  }
  if (state.assigneeDropdown) {
    closeAssigneeDropdown()
    return
  }
  if (state.typeDropdown) {
    state.typeDropdown = null
    render(modalsOnly)
    return
  }
  if (state.showSwapIssue) {
    state.showSwapIssue = null
    state.swapIssueCheck = null
    render(modalsOnly)
    return
  }
  if (state.showCreateIssue) {
    closeCreateIssueModal()
    return
  }
  if (state.showSettings) { closeSettings(); return }
  if (state.deletingWorklog) { state.deletingWorklog = null; render(modalsOnly); return }
  if (state.editingWorklog) { state.editingWorklog = null; render(modalsOnly); return }
  if (state.showManualLog) {
    state.showManualLog = null
    state.manualIssueCheck = null
    render(modalsOnly)
    return
  }
  if (state.showCancelConfirm) { state.showCancelConfirm = null; render(modalsOnly); return }
  if (state.showModal) {
    state.showModal = null
    state.finishIssueCheck = null
    render(modalsOnly)
    return
  }
  if (state.issueDetailModal) {
    // 댓글 삭제 확인 → ESC로 취소
    if (state.issueDetailModal.deletingCommentId && !state.issueDetailModal.commentSubmitting) {
      state.issueDetailModal.deletingCommentId = null
      render(modalsOnly)
      return
    }
    // 댓글 편집 중이면 ESC로 편집만 취소
    if (state.issueDetailModal.editingCommentId && !state.issueDetailModal.editingCommentSaving) {
      cancelEditComment()
      return
    }
    // 댓글 작성기 펼쳐진 상태면 ESC로 닫기
    if (state.issueDetailModal.commentComposeOpen && !state.issueDetailModal.commentSubmitting) {
      cancelCommentCompose()
      return
    }
    // 편집 중이면 ESC로 편집만 취소 (모달은 유지)
    if (state.issueDetailModal.editing) {
      cancelIssueDetailEdit()
    } else {
      closeIssueDetailModal()
    }
    return
  }
  // 모달이 모두 닫혀 있을 때 ESC: 다중 선택 해제
  if (state.selectedIssues.size > 0) {
    clearIssueSelection()
    render({ sections: ['content'] })
  }
}


// ----- 다중 선택 (이슈 목록 일괄 복사) -----
// 화면에 보이는 행의 키 목록 (DOM 기준 — 페이지/필터별 표시 순서를 그대로 따라감)
function getVisibleIssueKeys() {
  return Array.from(document.querySelectorAll('.issue-list .issue-row[data-issue-key]'))
    .map(r => r.dataset.issueKey)
}

function toggleIssueSelection(key, shift) {
  if (!key) return
  if (shift && state.lastSelectedIssueKey && state.lastSelectedIssueKey !== key) {
    // 마지막 기준점 ~ 현재 키까지 화면상의 범위를 모두 선택
    const visible = getVisibleIssueKeys()
    const a = visible.indexOf(state.lastSelectedIssueKey)
    const b = visible.indexOf(key)
    if (a >= 0 && b >= 0) {
      const [from, to] = a < b ? [a, b] : [b, a]
      for (let i = from; i <= to; i++) state.selectedIssues.add(visible[i])
      state.lastSelectedIssueKey = key
      return
    }
  }
  if (state.selectedIssues.has(key)) {
    state.selectedIssues.delete(key)
  } else {
    state.selectedIssues.add(key)
  }
  state.lastSelectedIssueKey = key
}

function clearIssueSelection() {
  state.selectedIssues.clear()
  state.lastSelectedIssueKey = null
}

// 선택된 이슈를 realIssues 순서대로 정렬해 클립보드에 복사
function copySelectedIssues(format) {
  if (state.selectedIssues.size === 0) return
  const ordered = state.realIssues.filter(i => state.selectedIssues.has(i.key))
  // realIssues에 없는 키(검색 결과 등)도 보존
  const found = new Set(ordered.map(i => i.key))
  for (const key of state.selectedIssues) {
    if (!found.has(key)) {
      const fromSearch = (state.searchResults || []).find(i => i.key === key)
      ordered.push(fromSearch || { key, summary: '' })
    }
  }
  let text = ''
  if (format === 'key') {
    text = ordered.map(i => i.key).join(', ')
  } else if (format === 'both') {
    text = ordered.map(i => `${i.key} ${i.summary || ''}`.trim()).join('\n')
  } else if (format === 'summary') {
    text = ordered.map(i => i.summary || '').join('\n')
  }
  navigator.clipboard.writeText(text).then(() => {
    const label = format === 'key' ? '이슈 키' : format === 'both' ? '이슈 키 + 요약' : '이슈 요약'
    showToast(`${ordered.length}개 ${label}을(를) 복사했습니다.`, '✓')
  }).catch(() => {
    showToast('복사에 실패했습니다.', '⚠')
  })
}

// ========== 이벤트 바인딩 ==========
export function bindEvents() {
  // 전역 ESC 키 리스너 (모달 닫기) — bindEvents는 render마다 호출되므로 한 번만 등록
  if (!globalKeyListenerRegistered) {
    on(document, 'keydown', handleGlobalKeydown)
    globalKeyListenerRegistered = true
  }
  if (!globalClickListenerRegistered) {
    on(document, 'click', handleGlobalClick)
    globalClickListenerRegistered = true
  }

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

  // 설정 FAB: 모달 열림/닫힘 토글
  const settingsFab = document.getElementById('btn-open-settings')
  if (settingsFab) {
    on(settingsFab, 'click', () => {
      if (state.showSettings) {
        // 이미 열려 있으면 닫기 (취소 버튼과 동일: 미리보기 롤백 포함)
        closeSettings()
        return
      }
      // 현재 저장된 prefs를 draft로 복제 후 열기
      state.settingsDraft = JSON.parse(JSON.stringify(state.userPrefs))
      state.showSettings = true
      render({ sections: ['modals', 'settings-fab'] })
    })
  }

  // 설정 모달은 ESC 또는 취소 버튼으로만 닫힘
  const settingsCancel = document.getElementById('settings-cancel')
  if (settingsCancel) on(settingsCancel, 'click', closeSettings)

  // 설정 모달: 기본값 재설정
  const settingsReset = document.getElementById('settings-reset')
  if (settingsReset) {
    on(settingsReset, 'click', () => {
      const d = resetPreferences()
      applyPreferences(d)
      state.settingsDraft = JSON.parse(JSON.stringify(d))
      render()
      showToast('설정을 기본값으로 되돌렸습니다.', '✓')
    })
  }

  // 설정 모달: 저장
  const settingsSave = document.getElementById('settings-save')
  if (settingsSave) {
    on(settingsSave, 'click', () => {
      if (!state.settingsDraft) return
      savePreferences(state.settingsDraft)
      applyPreferences(state.settingsDraft)
      state.showSettings = false
      state.settingsDraft = null
      render()
      showToast('설정을 저장했습니다.', '✓')
    })
  }

  // 주 시작 요일 세그먼트 버튼
  document.querySelectorAll('[data-week-start]').forEach(btn => {
    on(btn, 'click', () => {
      if (!state.settingsDraft) return
      state.settingsDraft.summaryWeekStart = btn.dataset.weekStart
      render({ sections: ['modals'] })
    })
  })

  // 프로젝트 색상 변경 (input type=color의 change 이벤트)
  document.querySelectorAll('[data-project-color]').forEach(input => {
    on(input, 'change', (e) => {
      const projectKey = input.dataset.projectColor
      const hex = e.target.value
      const colors = deriveProjectColors(hex)
      state.settingsDraft.projectColors[projectKey] = colors
      // 즉시 미리보기 CSS 변수 업데이트 (저장 전에도 시각 확인 가능)
      applyPreferences(state.settingsDraft)
      render({ sections: ['modals'] })
    })
  })

  // 드래그 앤 드롭 순서 변경 (포인터 기반, 밀림 애니메이션)
  document.querySelectorAll('.settings-drag-handle').forEach(handle => {
    on(handle, 'mousedown', (e) => {
      e.preventDefault()
      const item = handle.closest('.settings-order-item')
      if (!item) return
      const list = item.closest('.settings-order-list')
      const items = [...list.querySelectorAll('.settings-order-item')]
      const kind = item.dataset.kind
      const fromIdx = parseInt(item.dataset.idx, 10)
      const rects = items.map(el => el.getBoundingClientRect())
      const listGap = 4 // settings-order-list gap
      const stepH = rects[0].height + listGap

      // 고스트(드래그 중 커서 따라다니는 복제 요소)
      const ghost = item.cloneNode(true)
      ghost.className = 'settings-order-item drag-ghost'
      ghost.style.cssText = `position:fixed;left:${rects[fromIdx].left}px;top:${rects[fromIdx].top}px;width:${rects[fromIdx].width}px;z-index:999;pointer-events:none;`
      document.body.appendChild(ghost)

      item.classList.add('drag-placeholder')
      const startY = e.clientY
      const ghostStartTop = rects[fromIdx].top
      let currentIdx = fromIdx

      function onMove(ev) {
        const dy = ev.clientY - startY
        ghost.style.top = (ghostStartTop + dy) + 'px'

        // 고스트 중심 Y로 삽입 위치 계산
        const midY = ghostStartTop + dy + rects[fromIdx].height / 2
        let newIdx = 0
        for (let i = 0; i < rects.length; i++) {
          if (midY > rects[i].top + rects[i].height / 2) newIdx = i
        }
        newIdx = Math.max(0, Math.min(newIdx, items.length - 1))

        if (newIdx !== currentIdx) {
          currentIdx = newIdx
          items.forEach((el, i) => {
            if (i === fromIdx) return
            if (fromIdx < currentIdx) {
              el.style.transform = (i > fromIdx && i <= currentIdx) ? `translateY(-${stepH}px)` : ''
            } else {
              el.style.transform = (i >= currentIdx && i < fromIdx) ? `translateY(${stepH}px)` : ''
            }
          })
        }
      }

      function onUp() {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        ghost.remove()
        item.classList.remove('drag-placeholder')
        items.forEach(el => { el.style.transform = '' })

        if (currentIdx !== fromIdx) {
          const arr = kind === 'status'
            ? state.settingsDraft.statusOrder
            : state.settingsDraft.projectOrder
          const [moved] = arr.splice(fromIdx, 1)
          arr.splice(currentIdx, 0, moved)
        }
        render({ sections: ['modals'] })
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })
  })

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

  // 새 일감 모달 내부 핸들러 + tiptap 마운트
  bindCreateIssueEvents()
  ensureCreateIssueEditor()

  // 작업 로그 새로고침
  const refreshWorklogsBtn = document.getElementById('btn-refresh-worklogs')
  if (refreshWorklogsBtn) {
    on(refreshWorklogsBtn, 'click', () => refreshWorklogs())
  }

  // (.project-chip, .main-tab, .filter-tab 클릭은 events/_delegate.js로 위임됨)

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

  // ([data-page], [data-day-off] 클릭은 events/_delegate.js로 위임됨)

  // 달력 열기/닫기 토글
  // render()를 호출하면 log-body DOM이 교체되어 grid-template-columns transition이
  // 실행되지 않는다. 달력 DOM은 항상 렌더되므로, 기존 요소의 .with-calendar 클래스만
  // 토글하여 CSS transition을 실행시킨다.
  const calendarToggleBtn = document.getElementById('btn-calendar-toggle')
  if (calendarToggleBtn) {
    on(calendarToggleBtn, 'click', () => {
      state.calendarOpen = !state.calendarOpen
      localStorage.setItem('log_calendar_open', state.calendarOpen ? '1' : '0')
      const logBody = document.querySelector('.log-body')
      if (logBody) logBody.classList.toggle('with-calendar', state.calendarOpen)
      const label = state.calendarOpen ? '달력 닫기' : '달력 열기'
      calendarToggleBtn.title = label
      const span = calendarToggleBtn.querySelector('span')
      if (span) span.textContent = label
    })
  }

  // 달력 년/월 직접 선택
  const calYearSelect = document.getElementById('cal-year')
  if (calYearSelect) {
    on(calYearSelect, 'change', (e) => {
      state.calendarYear = parseInt(e.target.value, 10)
      // 미래 월 보정
      const now = new Date()
      if (state.calendarYear === now.getFullYear() && state.calendarMonth > now.getMonth()) {
        state.calendarMonth = now.getMonth()
      }
      if (isLoggedIn() && state.issuesLoaded) loadWorklogs(state.calendarYear, state.calendarMonth)
      render()
    })
  }

  const calMonthSelect = document.getElementById('cal-month')
  if (calMonthSelect) {
    on(calMonthSelect, 'change', (e) => {
      state.calendarMonth = parseInt(e.target.value, 10)
      if (isLoggedIn() && state.issuesLoaded) loadWorklogs(state.calendarYear, state.calendarMonth)
      render()
    })
  }

  // 달력 월 네비게이션
  const calPrev = document.getElementById('cal-prev')
  if (calPrev) {
    on(calPrev, 'click', () => {
      state.calendarMonth--
      if (state.calendarMonth < 0) { state.calendarMonth = 11; state.calendarYear-- }
      if (isLoggedIn() && state.issuesLoaded) loadWorklogs(state.calendarYear, state.calendarMonth)
      render()
    })
  }

  const calNext = document.getElementById('cal-next')
  if (calNext && !calNext.disabled) {
    on(calNext, 'click', () => {
      const now = new Date()
      const nextMonth = state.calendarMonth + 1
      const nextYear = nextMonth > 11 ? state.calendarYear + 1 : state.calendarYear
      const nm = nextMonth > 11 ? 0 : nextMonth
      if (nextYear < now.getFullYear() || (nextYear === now.getFullYear() && nm <= now.getMonth())) {
        state.calendarMonth = nm
        state.calendarYear = nextYear
        if (isLoggedIn() && state.issuesLoaded) loadWorklogs(state.calendarYear, state.calendarMonth)
        render()
      }
    })
  }

  const calToday = document.getElementById('cal-today')
  if (calToday) {
    on(calToday, 'click', () => {
      const now = new Date()
      state.calendarYear = now.getFullYear()
      state.calendarMonth = now.getMonth()
      state.logDate = toDateString(now)
      if (isLoggedIn() && state.issuesLoaded) loadWorklogs(state.calendarYear, state.calendarMonth)
      render()
    })
  }

  // ([data-cal-date] 클릭은 events/_delegate.js로 위임됨)

  // 목록 뷰 날짜 네비게이션
  const logPrev = document.getElementById('log-prev')
  if (logPrev) {
    on(logPrev, 'click', () => {
      state.logDate = shiftDate(state.logDate, -1)
      const d = new Date(state.logDate + 'T00:00:00')
      if (isLoggedIn() && state.issuesLoaded) loadWorklogs(d.getFullYear(), d.getMonth())
      render()
    })
  }

  const logNext = document.getElementById('log-next')
  if (logNext && !logNext.disabled) {
    on(logNext, 'click', () => {
      const next = shiftDate(state.logDate, 1)
      if (next <= toDateString(new Date())) {
        state.logDate = next
        const d = new Date(state.logDate + 'T00:00:00')
        if (isLoggedIn() && state.issuesLoaded) loadWorklogs(d.getFullYear(), d.getMonth())
        render()
      }
    })
  }

  const logToday = document.getElementById('log-today')
  if (logToday) {
    on(logToday, 'click', () => {
      state.logDate = toDateString(new Date())
      const d = new Date(state.logDate + 'T00:00:00')
      if (isLoggedIn() && state.issuesLoaded) loadWorklogs(d.getFullYear(), d.getMonth())
      render()
    })
  }

  // bindEvents()는 모든 render마다 호출되므로 가드가 없으면 부분 렌더(modals 등)에서도
  // 매번 새 flatpickr 인스턴스가 생성되어 calendar DOM과 document 리스너가 누수된다.
  // content 섹션이 재렌더될 때는 render.js가 먼저 destroy하므로 그 외에는 재생성하지 않는다.
  const logDatePicker = document.getElementById('log-date-picker')
  if (logDatePicker && !state.flatpickrInstance) {
    state.flatpickrInstance = flatpickr(logDatePicker, {
      locale: Korean,
      dateFormat: 'Y년 m월 d일 (D)',
      defaultDate: new Date(state.logDate + 'T00:00:00'),
      maxDate: 'today',
      disableMobile: true,
      onChange: (selectedDates) => {
        if (selectedDates.length > 0) {
          state.logDate = toDateString(selectedDates[0])
          render()
        }
      },
    })
  }

  // (.issue-row 클릭/우클릭, [data-action="toggle-select"], [data-bulk],
  //  .log-row 우클릭, [data-action="toggle-favorite"]는 events/_delegate.js로 위임됨)

  // 플로팅 패널 펼치기/접기
  const favToggle = document.getElementById('favorites-toggle')
  if (favToggle) {
    on(favToggle, 'click', (e) => {
      // render 직후 DOM이 교체되면 e.target이 detach되어 handleGlobalClick의
      // panel.contains(e.target) 검사를 통과하지 못하고 패널이 즉시 다시 닫히므로
      // 여기서 전파를 멈춰 document 핸들러가 받지 못하게 한다.
      e.stopPropagation()
      if (state.favoritesPanelCollapsed) {
        // 펼치기 — 기존 즉시 렌더
        state.favoritesPanelCollapsed = false
        localStorage.setItem('favorites_collapsed', '0')
        render({ sections: ['favorites'] })
      } else {
        // 접기 — 닫힘 애니메이션 경유
        closeFavoritesPanel()
      }
    })
  }

  // ([data-action="fav-start"], "fav-remove", "manual-log",
  //  .favorite-item 우클릭은 events/_delegate.js로 위임됨)

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

  // (data-action: toggle-type-menu / apply-type / toggle-status-menu /
  //  toggle-assignee-menu 클릭은 events/_delegate.js로 위임됨)

  // 담당자 검색 입력: 로컬 필터 즉시 적용 (API 재호출 없음)
  const assigneeSearchInput = document.getElementById('assignee-search-input')
  if (assigneeSearchInput) {
    if (state.assigneeDropdown && !state.assigneeDropdown._focused) {
      assigneeSearchInput.focus()
      state.assigneeDropdown._focused = true
    }
    on(assigneeSearchInput, 'input', (e) => {
      if (!state.assigneeDropdown) return
      state.assigneeDropdown.query = e.target.value
      refreshAssigneeDropdownList()
    })
  }

  // 리스트 항목 클릭 위임: 리스트 컨테이너에 한 번만 바인드
  // (부분 DOM 업데이트로 항목 DOM이 바뀌어도 핸들러는 컨테이너에 살아있음)
  const assigneeList = document.getElementById('assignee-dd-list')
  if (assigneeList) {
    on(assigneeList, 'click', async (e) => {
      const item = e.target.closest('.assignee-dd-item')
      if (!item) return
      e.stopPropagation()
      const dd = state.assigneeDropdown
      if (!dd) return
      const issueKey = dd.issueKey
      const accountId = item.dataset.assigneeId || ''
      const selected = accountId
        ? (dd.allUsers || []).find(u => u.accountId === accountId)
        : null
      closeAssigneeDropdown()
      await applyAssigneeChange(issueKey, accountId || null, selected)
    })
  }

  // ([data-action="apply-transition"] 클릭은 events/_delegate.js로 위임됨)

  // 필드 모달: 입력값을 state.values에 실시간 반영 (재렌더로 값 날아가지 않도록)
  document.querySelectorAll('.transition-field').forEach(input => {
    on(input, 'input', () => {
      if (!state.transitionFieldsModal) return
      const key = input.dataset.fieldKey
      state.transitionFieldsModal.values[key] = input.value
    })
    on(input, 'change', () => {
      if (!state.transitionFieldsModal) return
      const key = input.dataset.fieldKey
      state.transitionFieldsModal.values[key] = input.value
    })
  })

  // 필드 모달 취소
  const transitionFieldsCancel = document.getElementById('transition-fields-cancel')
  if (transitionFieldsCancel) {
    on(transitionFieldsCancel, 'click', () => {
      if (state.transitionFieldsModal?.submitting) return
      state.transitionFieldsModal = null
      render({ sections: ['modals'] })
    })
  }

  // 필드 모달 제출 → 전이 실행
  const transitionFieldsSubmit = document.getElementById('transition-fields-submit')
  if (transitionFieldsSubmit) {
    on(transitionFieldsSubmit, 'click', async () => {
      const ctx = state.transitionFieldsModal
      if (!ctx || ctx.submitting) return
      const { issueKey, transition, values } = ctx
      // 필수 필드 검증
      const missing = Object.entries(transition.fields || {})
        .filter(([, f]) => f.required)
        .filter(([key]) => {
          const v = values[key]
          return v === undefined || v === null || v === ''
        })
      if (missing.length > 0) {
        alert(`다음 필드를 입력해주세요:\n- ${missing.map(([, f]) => f.name || '-').join('\n- ')}`)
        return
      }
      ctx.submitting = true
      render({ sections: ['modals'] })
      const fieldsPayload = buildTransitionFieldsPayload(transition, values)
      await performTransition(issueKey, transition, fieldsPayload)
      state.transitionFieldsModal = null
      render({ sections: ['modals'] })
    })
  }

  // 이슈 목록 스크롤 시 드롭다운 닫기 (fixed position이라 스크롤 따라가지 않음)
  const issueListEl = document.querySelector('.issue-list')
  if (issueListEl) {
    on(issueListEl, 'scroll', () => {
      if (state.statusDropdown) {
        state.statusDropdown = null
        render({ sections: ['modals'] })
      }
    })
  }

  // (data-action: start / adjust-session-start / pause / resume / finish / cancel
  //  클릭은 events/_delegate.js로 위임됨)

  // 종료 모달은 ESC 또는 취소 버튼으로만 닫힘

  const modalCancel = document.getElementById('modal-cancel')
  if (modalCancel) {
    on(modalCancel, 'click', () => {
      state.showModal = null
      state.finishIssueCheck = null
      render({ sections: ['modals'] })
    })
  }

  // 이슈 상세 모달: 닫기 버튼들 + 첨부 클릭 시 새 탭으로 Jira 다운로드 URL 열기
  const detailCloseBtn = document.getElementById('issue-detail-close')
  if (detailCloseBtn) on(detailCloseBtn, 'click', closeIssueDetailModal)
  const detailCloseFooterBtn = document.getElementById('issue-detail-close-footer')
  if (detailCloseFooterBtn) on(detailCloseFooterBtn, 'click', closeIssueDetailModal)
  document.querySelectorAll('#issue-detail-overlay .detail-attachment').forEach(el => {
    on(el, 'click', async (e) => {
      e.preventDefault()
      const url = el.dataset.attachmentUrl
      if (!url) return
      const blobUrl = await fetchAttachmentBlobUrl(url)
      if (blobUrl) {
        // 새 탭에서 열고, 메모리 누수 방지를 위해 일정 시간 후 revoke
        window.open(blobUrl, '_blank', 'noopener,noreferrer')
        setTimeout(() => { try { URL.revokeObjectURL(blobUrl) } catch {} }, 60000)
      } else {
        showToast('첨부파일을 불러오지 못했습니다.', '⚠')
      }
    })
  })

  // 설명 영역 클릭 → 편집 모드 진입
  const detailDescEl = document.getElementById('issue-detail-description')
  if (detailDescEl) {
    on(detailDescEl, 'click', (e) => {
      // 설명 내부 링크/이미지 클릭은 기본 동작 유지
      if (e.target.closest('a, img')) return
      enterIssueDetailEditMode()
    })
  }

  // 요약 영역 클릭 → 인라인 편집 모드 진입
  const detailSummaryEl = document.getElementById('issue-detail-summary')
  if (detailSummaryEl) on(detailSummaryEl, 'click', enterSummaryEdit)

  // 요약 편집: input의 Enter=저장 / Esc=취소, 버튼 핸들러
  const summaryInput = document.getElementById('issue-detail-summary-input')
  if (summaryInput) {
    on(summaryInput, 'keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        saveSummaryEdit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()  // 전역 ESC 리스너의 모달 닫기 동작 차단
        cancelSummaryEdit()
      }
    })
  }
  const summaryCancelBtn = document.getElementById('issue-detail-summary-cancel')
  if (summaryCancelBtn) on(summaryCancelBtn, 'click', cancelSummaryEdit)
  const summarySaveBtn = document.getElementById('issue-detail-summary-save')
  if (summarySaveBtn) on(summarySaveBtn, 'click', saveSummaryEdit)

  // 편집 취소/저장 버튼
  const detailEditCancelBtn = document.getElementById('issue-detail-edit-cancel')
  if (detailEditCancelBtn) on(detailEditCancelBtn, 'click', cancelIssueDetailEdit)
  const detailEditSaveBtn = document.getElementById('issue-detail-edit-save')
  if (detailEditSaveBtn) on(detailEditSaveBtn, 'click', saveIssueDetailEdit)

  // tiptap 툴바 (본문 + 댓글 작성기 + 댓글 편집기 모두 동일 핸들러)
  // data-tt-mount-id로 어느 에디터를 조작할지 결정.
  document.querySelectorAll('.tiptap-toolbar').forEach(toolbar => {
    on(toolbar, 'click', (e) => {
      const btn = e.target.closest('[data-tt-cmd]')
      if (!btn) return
      e.preventDefault()
      const cmd = btn.dataset.ttCmd
      const mountId = toolbar.dataset.ttMountId
      const mount = mountId ? document.getElementById(mountId) : null
      const editor = getEditorOnMount(mount)
      if (!editor) return
      if (cmd === '__link') {
        const url = window.prompt('링크 URL을 입력하세요:')
        if (url) runCommandOnEditor(editor, 'setLink', { href: url })
        return
      }
      const argsRaw = btn.dataset.ttArgs
      const args = argsRaw ? JSON.parse(argsRaw) : null
      runCommandOnEditor(editor, cmd, args)
    })
  })

  // 편집 모드 tiptap 에디터 마운트 (중복 마운트 방지)
  ensureIssueDetailEditor()

  // ===== 댓글 영역 =====
  bindCommentEvents()
  ensureCommentEditors()

  // 일감 미지정 세션 종료 모달의 이슈 키 입력: 자동완성 드롭다운 + blur 검증
  const finishIssueInput = document.getElementById('finish-issue-key')
  if (finishIssueInput) {
    on(finishIssueInput, 'input', () => {
      state.finishIssueCheck = null
      renderKeyHint(FINISH_KEY_CTX)
      updateKeyDropdown(FINISH_KEY_CTX)
    })
    on(finishIssueInput, 'focus', () => {
      if (finishIssueInput.value.trim()) updateKeyDropdown(FINISH_KEY_CTX)
    })
    bindKeyDropdownNav(finishIssueInput, {
      dropdownId: 'finish-key-dropdown',
      activeIdxKey: 'finishKeyActiveIdx',
      selectCtx: FINISH_KEY_CTX,
    })
    on(finishIssueInput, 'blur', async () => {
      setTimeout(() => {
        const dd = document.getElementById('finish-key-dropdown')
        if (dd) { dd.style.display = 'none'; dd.innerHTML = '' }
      }, 150)
      const key = finishIssueInput.value.trim().toUpperCase()
      finishIssueInput.value = key
      if (!key) { state.finishIssueCheck = null; renderKeyHint(FINISH_KEY_CTX); return }
      if (state.finishIssueCheck && state.finishIssueCheck.key === key
          && (state.finishIssueCheck.status === 'ok' || state.finishIssueCheck.status === 'error')) {
        return
      }
      if (!isValidIssueKeyFormat(key)) {
        state.finishIssueCheck = { status: 'error', key, message: '올바른 형식이 아닙니다. 예: DKT-123' }
        renderKeyHint(FINISH_KEY_CTX)
        return
      }
      const local = findLoadedIssue(key)
      if (local) {
        state.finishIssueCheck = { status: 'ok', key, summary: local.summary }
        renderKeyHint(FINISH_KEY_CTX)
        return
      }
      state.finishIssueCheck = { status: 'checking', key }
      renderKeyHint(FINISH_KEY_CTX)
      try {
        const meta = await fetchIssueMeta(key)
        if (meta) {
          state.finishIssueCheck = { status: 'ok', key: meta.key, summary: meta.summary }
        } else {
          state.finishIssueCheck = { status: 'error', key, message: '이슈를 찾을 수 없습니다.' }
        }
      } catch {
        state.finishIssueCheck = { status: 'error', key, message: '이슈를 찾을 수 없거나 접근 권한이 없습니다.' }
      }
      renderKeyHint(FINISH_KEY_CTX)
    })
  }

  // 종료 모달: 구간별 시작/종료 시간 input → 실시간 소요 시간 readout 갱신
  document.querySelectorAll('.finish-seg-start, .finish-seg-end').forEach(inp => {
    on(inp, 'input', updateFinishDurationReadouts)
  })

  // ([data-action="delete-segment"] 클릭은 events/_delegate.js로 위임됨)

  // 종료 모달: 마지막 구간의 '지금' 버튼 → 종료 시간을 현재 시각으로 + 재계산
  document.querySelectorAll('.finish-seg-now').forEach(btn => {
    on(btn, 'click', () => {
      const i = btn.dataset.segIdx
      const endInput = document.querySelector(`.finish-seg-end[data-seg-idx="${i}"]`)
      if (!endInput) return
      const now = new Date()
      endInput.value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      updateFinishDurationReadouts()
    })
  })

  // 모달 열렸을 때 초기 readout 채움
  if (document.getElementById('modal-overlay')) {
    updateFinishDurationReadouts()
  }

  const modalSubmit = document.getElementById('modal-submit')
  if (modalSubmit) {
    on(modalSubmit, 'click', async () => {
      if (modalSubmit.disabled) return
      const sessions = loadSessions()
      const session = sessions.find(s => s.issueKey === state.showModal)
      if (!session) return

      // 일감 미지정 세션이면 입력된 이슈 키가 유효한지 먼저 확인
      const isIssueless = session.issueKey === NO_ISSUE_KEY
      let targetIssueKey = session.issueKey
      if (isIssueless) {
        const input = document.getElementById('finish-issue-key')
        const typed = (input?.value || '').trim().toUpperCase()
        if (!typed) { alert('이슈 키를 입력해주세요.'); return }
        if (!isValidIssueKeyFormat(typed)) { alert('이슈 키 형식이 올바르지 않습니다. 예: DKT-123'); return }
        if (state.finishIssueCheck?.status === 'error') { alert('이슈 키를 확인해주세요.'); return }
        if (state.finishIssueCheck?.status === 'checking') { alert('이슈 키를 확인 중입니다. 잠시만 기다려주세요.'); return }
        targetIssueKey = typed
      }

      // 편집된 구간 값 기반으로 검증 + 합계 계산
      const result = updateFinishDurationReadouts()
      if (!result.valid) {
        alert('유효하지 않은 구간이 있습니다.\n\n종료 시간은 시작 시간보다 이후여야 하며, 점심시간 제외 후 실 작업 시간이 1분 이상이어야 합니다.')
        return
      }
      if (result.totalActual <= 0) {
        alert(`기록 가능한 시간이 없습니다. 점심시간(${formatLunchRange()}) 제외 후 실제 작업 시간이 1분 이상이어야 합니다.`)
        return
      }
      const comment = document.getElementById('finish-comment')?.value || ''

      // 버튼 스피너 + 중복 클릭 차단
      const originalLabel = modalSubmit.innerHTML
      const modalCancelBtn = document.getElementById('modal-cancel')
      modalSubmit.disabled = true
      modalSubmit.classList.add('is-loading')
      modalSubmit.innerHTML = '<span class="btn-spinner"></span>'
      if (modalCancelBtn) modalCancelBtn.disabled = true

      const restore = () => {
        modalSubmit.disabled = false
        modalSubmit.classList.remove('is-loading')
        modalSubmit.innerHTML = originalLabel
        if (modalCancelBtn) modalCancelBtn.disabled = false
      }

      let successCount = 0
      try {
        // 편집된 구간 값을 이용해 worklog 생성.
        // 점심시간과 겹치면 buildWorklogSegments로 앞/뒤로 쪼개서 Jira에도 원래 시작/종료 시각 보존.
        for (const seg of result.perSegment) {
          if (!seg || !seg.valid || seg.actualMinutes <= 0) continue
          const subSegments = buildWorklogSegments(seg.date, seg.startTime, seg.endTime)
          for (const ss of subSegments) {
            await createWorklog(targetIssueKey, {
              started: ss.started,
              timeSpentSeconds: ss.seconds,
              comment,
            })
            successCount++
          }
        }
      } catch (e) {
        console.error('Jira worklog 기록 실패:', e)
        alert(`Jira 워크로그 기록에 실패했습니다.\n${e?.message || '알 수 없는 오류'}\n\n이미 ${successCount}건은 기록되었을 수 있습니다. 세션은 그대로 유지하며, 기록 여부는 Jira에서 직접 확인해 주세요.`)
        restore()
        return
      }

      if (successCount === 0) {
        alert('기록된 worklog가 없습니다. 세션은 유지됩니다.')
        restore()
        return
      }

      // 성공 시에만 세션 삭제 + 캐시 무효화
      removeSession(session.issueKey)
      state.showModal = null
      state.finishIssueCheck = null
      const invalidatedMonths = new Set()
      for (const seg of result.perSegment) {
        if (!seg || !seg.date) continue
        const monthStart = `${seg.date.substring(0, 7)}-01`
        if (!invalidatedMonths.has(monthStart)) {
          invalidatedMonths.add(monthStart)
          invalidateWorklogMonth(monthStart)
        }
      }
      showToast(`Jira에 ${successCount}건 기록했습니다.`, '✓')
      render()
    })
  }

  // ([data-action="swap-issue"] 클릭은 events/_delegate.js로 위임됨)

  // 일감 교체 모달: 취소
  const swapCancel = document.getElementById('swap-issue-cancel')
  if (swapCancel) {
    on(swapCancel, 'click', () => {
      state.showSwapIssue = null
      state.swapIssueCheck = null
      render({ sections: ['modals'] })
    })
  }

  // 일감 교체 모달: 이슈 키 입력 (자동완성 + blur 검증)
  const swapInput = document.getElementById('swap-issue-key')
  if (swapInput) {
    on(swapInput, 'input', () => {
      state.swapIssueCheck = null
      renderKeyHint(SWAP_KEY_CTX)
      updateKeyDropdown(SWAP_KEY_CTX)
    })
    on(swapInput, 'focus', () => {
      if (swapInput.value.trim()) updateKeyDropdown(SWAP_KEY_CTX)
    })
    bindKeyDropdownNav(swapInput, {
      dropdownId: 'swap-key-dropdown',
      activeIdxKey: 'swapKeyActiveIdx',
      selectCtx: SWAP_KEY_CTX,
    })
    on(swapInput, 'blur', async () => {
      setTimeout(() => {
        const dd = document.getElementById('swap-key-dropdown')
        if (dd) { dd.style.display = 'none'; dd.innerHTML = '' }
      }, 150)
      const key = swapInput.value.trim().toUpperCase()
      swapInput.value = key
      if (!key) { state.swapIssueCheck = null; renderKeyHint(SWAP_KEY_CTX); return }
      if (state.swapIssueCheck && state.swapIssueCheck.key === key
          && (state.swapIssueCheck.status === 'ok' || state.swapIssueCheck.status === 'error')) {
        return
      }
      if (!isValidIssueKeyFormat(key)) {
        state.swapIssueCheck = { status: 'error', key, message: '올바른 형식이 아닙니다. 예: DKT-123' }
        renderKeyHint(SWAP_KEY_CTX)
        return
      }
      const local = findLoadedIssue(key)
      if (local) {
        state.swapIssueCheck = { status: 'ok', key, summary: local.summary }
        renderKeyHint(SWAP_KEY_CTX)
        return
      }
      state.swapIssueCheck = { status: 'checking', key }
      renderKeyHint(SWAP_KEY_CTX)
      try {
        const meta = await fetchIssueMeta(key)
        if (meta) {
          state.swapIssueCheck = { status: 'ok', key: meta.key, summary: meta.summary }
        } else {
          state.swapIssueCheck = { status: 'error', key, message: '이슈를 찾을 수 없습니다.' }
        }
      } catch {
        state.swapIssueCheck = { status: 'error', key, message: '이슈를 찾을 수 없거나 접근 권한이 없습니다.' }
      }
      renderKeyHint(SWAP_KEY_CTX)
    })
  }

  // 일감 교체 모달: 제출
  const swapSubmit = document.getElementById('swap-issue-submit')
  if (swapSubmit) {
    on(swapSubmit, 'click', () => {
      if (swapSubmit.disabled) return
      const ctx = state.showSwapIssue
      if (!ctx) return
      const input = document.getElementById('swap-issue-key')
      const typed = (input?.value || '').trim().toUpperCase()
      if (!typed) { alert('이슈 키를 입력해주세요.'); return }
      if (!isValidIssueKeyFormat(typed)) { alert('이슈 키 형식이 올바르지 않습니다. 예: DKT-123'); return }
      if (state.swapIssueCheck?.status === 'error') { alert('이슈 키를 확인해주세요.'); return }
      if (state.swapIssueCheck?.status === 'checking') { alert('이슈 키를 확인 중입니다. 잠시만 기다려주세요.'); return }
      if (typed === ctx.oldKey) {
        // 동일 키면 변경 없음 — 모달만 닫기
        state.showSwapIssue = null
        state.swapIssueCheck = null
        render({ sections: ['modals'] })
        return
      }
      const newSummary = state.swapIssueCheck?.summary || findLoadedIssue(typed)?.summary || ''
      const result = swapSessionIssue(ctx.oldKey, typed, newSummary)
      if (!result.ok) {
        alert(result.error || '일감 교체에 실패했습니다.')
        return
      }
      state.showSwapIssue = null
      state.swapIssueCheck = null

      // swap 오버레이만 수동 제거 → 종료 모달 재렌더 방지해 코멘트/시간 입력 보존
      const swapOverlay = document.getElementById('swap-issue-overlay')
      if (swapOverlay) swapOverlay.remove()

      // 종료 모달이 이 세션을 참조 중이면 state와 issue-info DOM만 새 키로 갱신
      if (state.showModal === ctx.oldKey) {
        state.showModal = typed
        const finishIssueInfo = document.querySelector('#modal-overlay .modal-issue-info')
        if (finishIssueInfo) {
          const keyEl = finishIssueInfo.querySelector('.issue-key')
          const sumEl = finishIssueInfo.querySelector('.modal-issue-summary')
          const btnEl = finishIssueInfo.querySelector('[data-action="swap-issue"]')
          if (keyEl) keyEl.textContent = typed
          if (sumEl) sumEl.textContent = newSummary
          if (btnEl) {
            btnEl.dataset.key = typed
            btnEl.dataset.summary = newSummary
          }
        }
      }
      if (state.showCancelConfirm === ctx.oldKey) state.showCancelConfirm = typed

      showToast(`일감을 ${typed}(으)로 교체했습니다.`, '✓')
      // 상단 현재 작업 카드만 재렌더 (종료 모달이 유지되어야 하므로 modals 섹션은 건드리지 않음)
      render({ sections: ['sessions'] })
    })
  }

  // 취소 컨펌 모달은 ESC 또는 버튼으로만 닫힘

  const cancelNo = document.getElementById('cancel-confirm-no')
  if (cancelNo) {
    on(cancelNo, 'click', () => { state.showCancelConfirm = null; render({ sections: ['modals'] }) })
  }

  const cancelYes = document.getElementById('cancel-confirm-yes')
  if (cancelYes) {
    on(cancelYes, 'click', () => {
      removeSession(state.showCancelConfirm)
      state.showCancelConfirm = null
      render()
    })
  }

  // 수동 기록 버튼
  const manualLogBtn = document.getElementById('btn-manual-log')
  if (manualLogBtn) {
    on(manualLogBtn, 'click', () => {
      state.showManualLog = {}
      state.manualIssueCheck = null
      render({ sections: ['modals'] })
    })
  }

  // 수동 기록 모달은 ESC 또는 취소 버튼으로만 닫힘

  const manualCancel = document.getElementById('manual-log-cancel')
  if (manualCancel) {
    on(manualCancel, 'click', () => { state.showManualLog = null; state.manualIssueCheck = null; render({ sections: ['modals'] }) })
  }

  // 이슈 키 입력: 자동완성 드롭다운
  const manualIssueInput = document.getElementById('manual-issue-key')
  if (manualIssueInput) {
    on(manualIssueInput, 'input', () => {
      state.manualIssueCheck = null
      renderManualKeyHint()
      updateManualKeyDropdown()
    })
    on(manualIssueInput, 'focus', () => {
      if (manualIssueInput.value.trim()) updateManualKeyDropdown()
    })
    // 키보드 네비게이션 (manual은 selectManualKeyCandidate가 MANUAL_KEY_CTX로 selectKeyCandidate를 호출하는 wrapper)
    bindKeyDropdownNav(manualIssueInput, {
      dropdownId: 'manual-key-dropdown',
      activeIdxKey: 'manualKeyActiveIdx',
      selectCtx: MANUAL_KEY_CTX,
    })
  }

  // 이슈 키 입력: blur 시 유효성 검사 (폼 초기화 방지 위해 render() 대신 힌트 DOM 직접 업데이트)
  if (manualIssueInput) {
    on(manualIssueInput, 'blur', async () => {
      // blur 후 드롭다운 닫기 (mousedown 선택이 먼저 처리되도록 지연)
      setTimeout(() => {
        const dd = document.getElementById('manual-key-dropdown')
        if (dd) { dd.style.display = 'none'; dd.innerHTML = '' }
      }, 150)
      const key = manualIssueInput.value.trim().toUpperCase()
      manualIssueInput.value = key
      if (!key) { state.manualIssueCheck = null; renderManualKeyHint(); return }
      // 같은 키가 이미 검증 완료되어 있으면 네트워크 재호출 스킵
      if (state.manualIssueCheck && state.manualIssueCheck.key === key
          && (state.manualIssueCheck.status === 'ok' || state.manualIssueCheck.status === 'error')) {
        return
      }
      if (!isValidIssueKeyFormat(key)) {
        state.manualIssueCheck = { status: 'error', key, message: '올바른 형식이 아닙니다. 예: DKT-123' }
        renderManualKeyHint()
        return
      }
      const local = findLoadedIssue(key)
      if (local) {
        state.manualIssueCheck = { status: 'ok', key, summary: local.summary }
        renderManualKeyHint()
        return
      }
      state.manualIssueCheck = { status: 'checking', key }
      renderManualKeyHint()
      try {
        const meta = await fetchIssueMeta(key)
        if (meta) {
          state.manualIssueCheck = { status: 'ok', key: meta.key, summary: meta.summary }
        } else {
          state.manualIssueCheck = { status: 'error', key, message: '이슈를 찾을 수 없습니다.' }
        }
      } catch {
        state.manualIssueCheck = { status: 'error', key, message: '이슈를 찾을 수 없거나 접근 권한이 없습니다.' }
      }
      renderManualKeyHint()
    })
  }

  // 시작 시간 자동 채우기: 선택된 날짜의 마지막 worklog endTime으로 설정
  // (사용자가 수동으로 수정하면 autofill 플래그가 꺼져 다음 자동 주입을 건드리지 않음)
  const manualStartInputEl = document.getElementById('manual-start-time')
  if (manualStartInputEl) {
    on(manualStartInputEl, 'input', () => {
      manualStartInputEl.dataset.autofilled = '0'
    })
  }

  async function autofillManualStartTime() {
    const dateInput = document.getElementById('manual-date')
    const startInput = document.getElementById('manual-start-time')
    if (!dateInput || !startInput) return
    const date = dateInput.value
    if (!date) return
    const d = new Date(date + 'T00:00:00')
    try {
      await ensureMonthWorklogsLoaded(d.getFullYear(), d.getMonth())
    } catch (e) {
      console.warn('작업 로그 로드 실패:', e)
      return
    }
    const latestEnd = getLatestEndTimeForDate(date)
    if (!latestEnd) return
    // 사용자가 입력란을 직접 건드렸다면 덮어쓰지 않음
    if (startInput.dataset.autofilled === '0') return
    startInput.value = latestEnd
    startInput.dataset.autofilled = '1'
    updateManualDurationReadout()
  }

  // 모달 열린 직후: 아직 worklog가 로드되지 않았을 수 있으므로 비동기로 확인
  autofillManualStartTime()

  // 날짜 변경 시 시작 시간 재계산 (사용자 수정 전인 경우에만)
  const manualDateInput = document.getElementById('manual-date')
  if (manualDateInput) {
    on(manualDateInput, 'change', () => {
      const startInput = document.getElementById('manual-start-time')
      if (startInput) startInput.dataset.autofilled = '1'  // 자동 채움 허용 상태로 복귀
      autofillManualStartTime()
    })
  }

  // '지금' 버튼: 종료 시간을 현재 시각으로
  const manualEndNow = document.getElementById('manual-end-now')
  if (manualEndNow) {
    on(manualEndNow, 'click', () => {
      const now = new Date()
      const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const endInput = document.getElementById('manual-end-time')
      if (endInput) {
        endInput.value = nowTime
        updateManualDurationReadout()
      }
    })
  }

  // 시작/종료 시간 변경 → 소요 시간 실시간 계산
  const manualStartInput = document.getElementById('manual-start-time')
  const manualEndInput = document.getElementById('manual-end-time')
  if (manualStartInput) on(manualStartInput, 'input', updateManualDurationReadout)
  if (manualEndInput) on(manualEndInput, 'input', updateManualDurationReadout)
  if (manualStartInput || manualEndInput) updateManualDurationReadout()

  const manualSubmit = document.getElementById('manual-log-submit')
  const manualCancelBtn = document.getElementById('manual-log-cancel')
  if (manualSubmit) {
    on(manualSubmit, 'click', async () => {
      if (manualSubmit.disabled) return
      const issueKey = document.getElementById('manual-issue-key').value.trim().toUpperCase()
      const date = document.getElementById('manual-date').value
      const startTime = document.getElementById('manual-start-time').value
      const endTime = document.getElementById('manual-end-time').value
      const comment = document.getElementById('manual-comment').value

      if (!issueKey) { alert('이슈 키를 입력해주세요.'); return }
      if (!isValidIssueKeyFormat(issueKey)) { alert('이슈 키 형식이 올바르지 않습니다. 예: DKT-123'); return }
      if (state.manualIssueCheck?.status === 'error') { alert('이슈 키를 확인해주세요.'); return }
      if (!date) { alert('날짜를 입력해주세요.'); return }

      const dur = computeDurationFromTimes(startTime, endTime)
      if (!dur.valid) { alert(dur.message); return }

      // 점심시간이 겹치면 두 개 구간으로 쪼개서 기록 (종료 시간 유지를 위해)
      const segments = buildWorklogSegments(date, startTime, endTime)
      if (segments.length === 0) { alert('유효한 작업 구간이 없습니다.'); return }

      // 제출 중: 버튼을 스피너로 전환 + 중복 클릭 방지
      const originalLabel = manualSubmit.innerHTML
      manualSubmit.disabled = true
      manualSubmit.classList.add('is-loading')
      manualSubmit.innerHTML = '<span class="btn-spinner"></span>'
      if (manualCancelBtn) manualCancelBtn.disabled = true

      try {
        for (const seg of segments) {
          await createWorklog(issueKey, { started: seg.started, timeSpentSeconds: seg.seconds, comment })
        }
        state.showManualLog = null
        state.manualIssueCheck = null
        invalidateWorklogMonth(date)
        showToast('작업 로그가 기록되었습니다.', '✓')
        render()
      } catch (e) {
        console.error('수동 작업 기록 실패:', e)
        alert(`작업 기록에 실패했습니다.\n\n${formatJiraError(e)}`)
        manualSubmit.disabled = false
        manualSubmit.classList.remove('is-loading')
        manualSubmit.innerHTML = originalLabel
        if (manualCancelBtn) manualCancelBtn.disabled = false
      }
    })
  }

  // 요약 탭 주차 네비게이션
  const summaryPrev = document.getElementById('summary-prev')
  if (summaryPrev) {
    on(summaryPrev, 'click', () => {
      state.summaryWeekOffset--
      ensureSummaryWorklogs()
      render()
    })
  }

  const summaryNext = document.getElementById('summary-next')
  if (summaryNext && !summaryNext.disabled) {
    on(summaryNext, 'click', () => {
      if (state.summaryWeekOffset < 0) {
        state.summaryWeekOffset++
        ensureSummaryWorklogs()
        render()
      }
    })
  }

  const summaryThisWeek = document.getElementById('summary-this-week')
  if (summaryThisWeek) {
    on(summaryThisWeek, 'click', () => {
      state.summaryWeekOffset = 0
      ensureSummaryWorklogs()
      render()
    })
  }

  // ([data-chart-date], [data-action="edit-log"], "delete-log" 클릭은 events/_delegate.js로 위임됨)

  // 수정 모달은 ESC 또는 취소 버튼으로만 닫힘

  const editCancel = document.getElementById('edit-worklog-cancel')
  if (editCancel) {
    on(editCancel, 'click', () => { state.editingWorklog = null; render({ sections: ['modals'] }) })
  }

  // 수정 모달: '지금' 버튼 + 실시간 계산
  const editEndNow = document.getElementById('edit-end-now')
  if (editEndNow) {
    on(editEndNow, 'click', () => {
      const now = new Date()
      const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const endInput = document.getElementById('edit-end-time')
      if (endInput) {
        endInput.value = nowTime
        updateEditDurationReadout()
      }
    })
  }
  const editStartInput = document.getElementById('edit-start-time')
  const editEndInput = document.getElementById('edit-end-time')
  if (editStartInput) on(editStartInput, 'input', updateEditDurationReadout)
  if (editEndInput) on(editEndInput, 'input', updateEditDurationReadout)
  if (editStartInput || editEndInput) updateEditDurationReadout()

  const editSubmit = document.getElementById('edit-worklog-submit')
  const editCancelBtn = document.getElementById('edit-worklog-cancel')
  if (editSubmit) {
    on(editSubmit, 'click', async () => {
      if (editSubmit.disabled) return
      const startTime = document.getElementById('edit-start-time').value
      const endTime = document.getElementById('edit-end-time').value
      const comment = document.getElementById('edit-comment').value

      const dur = computeDurationFromTimes(startTime, endTime)
      if (!dur.valid) { alert(dur.message); return }

      // 점심시간이 겹치면 기존 worklog는 첫 구간으로 수정하고 뒤 구간은 별도 생성
      const segments = buildWorklogSegments(state.editingWorklog.date, startTime, endTime)
      if (segments.length === 0) { alert('유효한 작업 구간이 없습니다.'); return }

      const originalLabel = editSubmit.innerHTML
      editSubmit.disabled = true
      editSubmit.classList.add('is-loading')
      editSubmit.innerHTML = '<span class="btn-spinner"></span>'
      if (editCancelBtn) editCancelBtn.disabled = true

      try {
        await updateWorklog(state.editingWorklog.issueKey, state.editingWorklog.worklogId, {
          started: segments[0].started,
          timeSpentSeconds: segments[0].seconds,
          comment,
        })
        for (let i = 1; i < segments.length; i++) {
          await createWorklog(state.editingWorklog.issueKey, {
            started: segments[i].started,
            timeSpentSeconds: segments[i].seconds,
            comment,
          })
        }
        const savedDate = state.editingWorklog.date
        state.editingWorklog = null
        invalidateWorklogMonth(savedDate)
        showToast('작업 로그를 수정했습니다.', '✓')
      } catch (e) {
        console.error('작업 로그 수정 실패:', e)
        alert(`작업 로그 수정에 실패했습니다.\n\n${formatJiraError(e)}`)
        editSubmit.disabled = false
        editSubmit.classList.remove('is-loading')
        editSubmit.innerHTML = originalLabel
        if (editCancelBtn) editCancelBtn.disabled = false
      }
    })
  }

  // 삭제 확인 모달
  // 삭제 확인 모달은 ESC 또는 버튼으로만 닫힘

  const deleteNo = document.getElementById('delete-worklog-no')
  if (deleteNo) {
    on(deleteNo, 'click', () => { state.deletingWorklog = null; render({ sections: ['modals'] }) })
  }

  const deleteYes = document.getElementById('delete-worklog-yes')
  const deleteNoBtn = document.getElementById('delete-worklog-no')
  if (deleteYes) {
    on(deleteYes, 'click', async () => {
      if (deleteYes.disabled) return
      try {
        await withSpinner(deleteYes, async () => {
          await deleteWorklog(state.deletingWorklog.issueKey, state.deletingWorklog.worklogId)
          state.deletingWorklog = null
          // 성공 시 loadWorklogs → render가 호출되어 모달이 닫힘
          invalidateWorklogMonth(state.logDate)
        }, [deleteNoBtn])
      } catch (e) {
        console.error('작업 로그 삭제 실패:', e)
        alert(`작업 로그 삭제에 실패했습니다.\n\n${formatJiraError(e)}`)
      }
    })
  }
}

// ========== 이벤트 위임 등록 (1회) ==========
// 자주 갱신되는 element들의 클릭/우클릭/data-* 핸들러는 모두 document 레벨로 위임.
// 기존: render마다 수십 개의 querySelectorAll + addEventListener
// 변경: 앱 시작 시 1회만 등록. element가 새로 그려져도 재바인드 불필요.
let delegationInstalled = false
export function installDelegatedHandlers() {
  if (delegationInstalled) return
  delegationInstalled = true

  // ===== data-action 기반 핸들러 =====

  // 다중 선택 체크박스
  registerClickAction('toggle-select', (e, el) => {
    e.stopImmediatePropagation()
    e.preventDefault()  // native checkbox 토글 막고 직접 컨트롤
    toggleIssueSelection(el.dataset.key, e.shiftKey)
    render({ sections: ['content'] })
  })

  // 즐겨찾기 토글 (이슈 행의 별표)
  registerClickAction('toggle-favorite', (e, btn) => {
    e.stopImmediatePropagation()
    const key = btn.dataset.key
    const pool = [...getActiveIssues(), ...(state.searchResults || [])]
    const issue = pool.find(i => i.key === key)
    toggleFavorite(key, issue?.summary || '')
    render()
  })

  // 즐겨찾기 패널의 시작 버튼
  registerClickAction('fav-start', (e, btn) => {
    e.stopImmediatePropagation()
    const key = btn.dataset.key
    const summary = btn.dataset.summary || ''
    addSession(key, summary)
    render()
  })

  // 즐겨찾기 해제 (패널 내부)
  registerClickAction('fav-remove', (e, btn) => {
    e.stopImmediatePropagation()
    toggleFavorite(btn.dataset.key, '')
    render()
  })

  // 이슈 행 호버 시 표시되는 '수동 기록' 버튼
  registerClickAction('manual-log', (e, btn) => {
    e.stopImmediatePropagation()
    const key = btn.dataset.key
    const pool = [...getActiveIssues(), ...(state.searchResults || [])]
    const issue = pool.find(i => i.key === key)
    if (!issue) return
    state.showManualLog = { issueKey: key, summary: issue.summary }
    state.manualIssueCheck = { status: 'ok', key, summary: issue.summary }
    render()
  })

  // 이슈 유형 드롭다운 토글
  registerClickAction('toggle-type-menu', async (e, btn) => {
    e.stopImmediatePropagation()
    const key = btn.dataset.key
    if (!key) return
    if (state.typeDropdown && state.typeDropdown.issueKey === key) {
      state.typeDropdown = null
      render({ sections: ['modals'] })
      return
    }
    const rect = btn.getBoundingClientRect()
    const cached = getCachedIssueTypes(key)
    state.typeDropdown = {
      issueKey: key,
      currentTypeName: btn.dataset.currentType || '',
      rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      types: cached,
      loading: !cached,
    }
    if (state.statusDropdown) state.statusDropdown = null
    if (state.assigneeDropdown) closeAssigneeDropdown({ skipRender: true })
    render({ sections: ['modals'] })
    try {
      const types = await fetchIssueTypes(key)
      setCachedIssueTypes(key, types)
      if (state.typeDropdown && state.typeDropdown.issueKey === key) {
        state.typeDropdown.types = types
        state.typeDropdown.loading = false
        render({ sections: ['modals'] })
      }
    } catch (err) {
      console.error('이슈 유형 조회 실패:', err)
      if (cached) return
      if (state.typeDropdown && state.typeDropdown.issueKey === key) {
        state.typeDropdown = null
        render({ sections: ['modals'] })
      }
      showToast(`유형 조회 실패: ${formatJiraError(err)}`, '⚠')
    }
  })

  // 유형 드롭다운 항목 선택
  registerClickAction('apply-type', async (e, btn) => {
    e.stopImmediatePropagation()
    const dd = state.typeDropdown
    if (!dd) return
    const issueKey = dd.issueKey
    const typeInfo = {
      id: btn.dataset.typeId,
      name: btn.dataset.typeName || '',
      iconUrl: btn.dataset.typeIcon || '',
    }
    state.typeDropdown = null
    render({ sections: ['modals'] })
    await performTypeChange(issueKey, typeInfo)
  })

  // 이슈 상태 버튼 → 전이 드롭다운 토글
  registerClickAction('toggle-status-menu', async (e, btn) => {
    e.stopImmediatePropagation()
    const key = btn.dataset.key
    if (!key) return
    if (state.statusDropdown && state.statusDropdown.issueKey === key) {
      state.statusDropdown = null
      render({ sections: ['modals'] })
      return
    }
    const rect = btn.getBoundingClientRect()
    const cached = getCachedTransitions(key)
    state.statusDropdown = {
      issueKey: key,
      currentStatus: btn.dataset.currentStatus || '',
      rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      transitions: cached,
      loading: !cached,
    }
    render({ sections: ['modals'] })
    try {
      const transitions = await fetchTransitions(key)
      setCachedTransitions(key, transitions)
      if (state.statusDropdown && state.statusDropdown.issueKey === key) {
        state.statusDropdown.transitions = transitions
        state.statusDropdown.loading = false
        render({ sections: ['modals'] })
      }
    } catch (err) {
      console.error('전이 조회 실패:', err)
      if (cached) return
      if (state.statusDropdown && state.statusDropdown.issueKey === key) {
        state.statusDropdown = null
        render({ sections: ['modals'] })
      }
      showToast(`상태 조회 실패: ${formatJiraError(err)}`, '⚠')
    }
  })

  // 담당자 아바타 클릭 → 드롭다운 토글
  registerClickAction('toggle-assignee-menu', (e, el) => {
    e.stopImmediatePropagation()
    const key = el.dataset.issueKey
    if (!key) return
    if (state.assigneeDropdown && state.assigneeDropdown.issueKey === key) {
      closeAssigneeDropdown()
      return
    }
    if (state.assigneeDropdown) closeAssigneeDropdown({ skipRender: true })
    const rect = el.getBoundingClientRect()
    const cached = getCachedAssignableUsers(key)
    state.assigneeDropdown = {
      issueKey: key,
      rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      allUsers: cached,
      loading: !cached,
      query: '',
    }
    if (state.statusDropdown) state.statusDropdown = null
    render({ sections: ['modals'] })
    loadAssignableUsers(key)
  })

  // 드롭다운의 전이 항목 선택
  registerClickAction('apply-transition', async (e, btn) => {
    e.stopImmediatePropagation()
    const dd = state.statusDropdown
    if (!dd) return
    const transitionId = btn.dataset.transitionId
    const needsFields = btn.dataset.needsFields === '1'
    const transition = (dd.transitions || []).find(t => String(t.id) === String(transitionId))
    if (!transition) return
    const issueKey = dd.issueKey
    state.statusDropdown = null
    if (needsFields) {
      state.transitionFieldsModal = { issueKey, transition, values: {}, submitting: false }
      render({ sections: ['modals'] })
      return
    }
    render({ sections: ['modals'] })
    await performTransition(issueKey, transition, null)
  })

  // 이슈 목록에서 작업 시작
  registerClickAction('start', (e, btn) => {
    e.stopImmediatePropagation()
    const key = btn.dataset.key
    const allIssues = [...getActiveIssues(), ...(state.searchResults || [])]
    const issue = allIssues.find(i => i.key === key)
    if (issue) {
      addSession(key, issue.summary)
      render()
    }
  })

  // 세션 시작 시간을 직전 로그 종료 시간으로 조정
  registerClickAction('adjust-session-start', async (e, btn) => {
    e.stopImmediatePropagation()
    if (btn.disabled) return
    const key = btn.dataset.key
    const sessions = loadSessions()
    const s = sessions.find(x => x.issueKey === key)
    if (!s || !s.segments.length) return
    const firstSeg = s.segments[0]
    const startDate = firstSeg.start
    const dateStr = toDateString(startDate)

    const originalLabel = btn.textContent
    btn.disabled = true
    btn.textContent = '불러오는 중...'
    try {
      await ensureMonthWorklogsLoaded(startDate.getFullYear(), startDate.getMonth())
    } catch (err) {
      console.error('작업 로그 로드 실패:', err)
      showToast('작업 로그를 불러오지 못했습니다.', '⚠')
      btn.disabled = false
      btn.textContent = originalLabel
      return
    }
    btn.disabled = false
    btn.textContent = originalLabel

    const logs = state.worklogsByDate[dateStr] || []
    if (!logs.length) {
      showToast('해당 날짜에 기록된 작업 로그가 없습니다.', 'ℹ')
      return
    }
    const latestEnd = logs.reduce((max, l) => (l.endTime > max ? l.endTime : max), '00:00')
    const [h, m] = latestEnd.split(':').map(Number)
    const newStart = new Date(startDate)
    newStart.setHours(h, m, 0, 0)

    if (newStart.getTime() >= firstSeg.start.getTime()) {
      showToast('직전 종료 시간이 현재 시작 시간보다 늦어 조정할 수 없습니다.', 'ℹ')
      return
    }
    firstSeg.start = newStart
    saveSessions(sessions)
    showToast(`시작 시간을 ${latestEnd}(으)로 조정했습니다.`, '✓')
    render()
  })

  // 세션 중단
  registerClickAction('pause', (e, btn) => {
    e.stopImmediatePropagation()
    pauseSession(btn.dataset.key)
    render()
  })

  // 세션 재개
  registerClickAction('resume', (e, btn) => {
    e.stopImmediatePropagation()
    resumeSession(btn.dataset.key)
    render()
  })

  // 작업 종료 버튼 → 종료 모달
  registerClickAction('finish', (e, btn) => {
    e.stopImmediatePropagation()
    state.showModal = btn.dataset.key
    state.finishIssueCheck = null
    state.finishKeyActiveIdx = -1
    render({ sections: ['modals'] })
  })

  // 작업 취소 버튼 → 컨펌 모달
  registerClickAction('cancel', (e, btn) => {
    e.stopImmediatePropagation()
    state.showCancelConfirm = btn.dataset.key
    render({ sections: ['modals'] })
  })

  // 종료 모달의 구간 삭제
  registerClickAction('delete-segment', (e, btn) => {
    e.stopImmediatePropagation()
    const segIdx = parseInt(btn.dataset.segIdx, 10)
    if (!Number.isFinite(segIdx)) return
    if (!confirm(`구간 ${segIdx + 1}을(를) 삭제할까요?\n이 구간의 작업 시간은 Jira에 기록되지 않습니다.`)) return
    const result = deleteSessionSegment(state.showModal, segIdx)
    if (!result.ok) {
      alert(result.error || '구간 삭제에 실패했습니다.')
      return
    }
    render({ sections: ['sessions', 'modals'] })
  })

  // 일감 교체 버튼 → 교체 모달
  registerClickAction('swap-issue', (e, btn) => {
    e.stopImmediatePropagation()
    const oldKey = btn.dataset.key
    const summary = btn.dataset.summary || ''
    if (!oldKey) return
    state.showSwapIssue = { oldKey, summary }
    state.swapIssueCheck = null
    state.swapKeyActiveIdx = -1
    render({ sections: ['modals'] })
  })

  // 작업 로그 수정 버튼
  registerClickAction('edit-log', (e, btn) => {
    e.stopImmediatePropagation()
    const idx = parseInt(btn.dataset.idx, 10)
    const logs = getActiveLogs(state.logDate)
    const log = logs[idx]
    if (!log?.worklogId) return
    state.editingWorklog = {
      worklogId: log.worklogId,
      issueKey: log.issueKey,
      summary: log.summary,
      startTime: log.startTime,
      durationHours: Math.floor(log.durationMinutes / 60),
      durationMins: log.durationMinutes % 60,
      comment: log.comment || '',
      date: state.logDate,
    }
    render({ sections: ['modals'] })
  })

  // 작업 로그 삭제 버튼
  registerClickAction('delete-log', (e, btn) => {
    e.stopImmediatePropagation()
    const idx = parseInt(btn.dataset.idx, 10)
    const logs = getActiveLogs(state.logDate)
    const log = logs[idx]
    if (!log?.worklogId) return
    state.deletingWorklog = {
      worklogId: log.worklogId,
      issueKey: log.issueKey,
      summary: log.summary,
    }
    render({ sections: ['modals'] })
  })

  // ===== data-* 키 기반 핸들러 =====

  // 일괄 복사 액션 바 (data-bulk)
  registerClickData('bulk', (e, btn) => {
    e.stopImmediatePropagation()
    const action = btn.dataset.bulk
    if (action === 'clear') {
      clearIssueSelection()
      render({ sections: ['content'] })
      return
    }
    copySelectedIssues(action)
  })

  // 페이지네이션 (data-page)
  registerClickData('page', (e, btn) => {
    state.currentPage = parseInt(btn.dataset.page, 10)
    render()
    resetIssueListScroll()
    document.querySelector('.issue-list')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  })

  // 연반차 토글 (data-day-off)
  registerClickData('dayOff', (e, btn) => {
    const value = btn.dataset.dayOff
    setDayOff(state.logDate, value === 'none' ? null : value)
    render()
  })

  // 달력 날짜 셀 (data-cal-date)
  registerClickData('calDate', (e, cell) => {
    state.logDate = cell.dataset.calDate
    render()
  })

  // 요약 탭 일별 차트 막대 (data-chart-date)
  registerClickData('chartDate', (e, col) => {
    const dateStr = col.dataset.chartDate
    if (!dateStr) return
    const d = new Date(dateStr + 'T00:00:00')
    state.currentMainTab = 'logs'
    state.calendarYear = d.getFullYear()
    state.calendarMonth = d.getMonth()
    state.logDate = dateStr
    state.calendarOpen = true
    localStorage.setItem('log_calendar_open', '1')
    if (isLoggedIn() && state.issuesLoaded) {
      loadWorklogs(d.getFullYear(), d.getMonth())
    }
    render()
  })

  // ===== 셀렉터 기반 핸들러 (class 기반) =====

  // 프로젝트 선택 칩
  registerClickSelector('.project-chip', (e, chip) => {
    state.currentProject = chip.dataset.project
    state.currentFilterTab = 'all'
    state.currentPage = 1
    state.searchQuery = ''
    state.searchResults = null
    render()
    resetIssueListScroll()
  })

  // 메인 탭
  registerClickSelector('.main-tab', (e, tab) => {
    state.currentMainTab = tab.dataset.mainTab
    if (tab.dataset.mainTab === 'logs' && isLoggedIn() && state.issuesLoaded) {
      loadWorklogs(state.calendarYear, state.calendarMonth)
    }
    if (tab.dataset.mainTab === 'summary') {
      ensureSummaryWorklogs()
    }
    render()
  })

  // 필터 탭
  registerClickSelector('.filter-tab', (e, tab) => {
    state.currentFilterTab = tab.dataset.filter
    state.currentPage = 1
    state.searchQuery = ''
    state.searchResults = null
    render()
    resetIssueListScroll()
  })

  // 이슈 행 좌클릭 → 상세 모달 (action/링크/버튼 영역은 위에서 처리되어 여기 도달 안 함)
  registerClickSelector('.issue-row[data-issue-key]', (e, row) => {
    // dispatchClick은 data-action 매칭에서 이미 return하므로 보수적 가드만
    if (e.target.closest('a, button')) return
    const key = row.dataset.issueKey
    if (key) openIssueDetailModal(key)
  })

  // ===== 우클릭 (contextmenu) =====
  registerContextMenu('.issue-row[data-issue-key]', (e, row) => {
    const key = row.dataset.issueKey
    const summary = row.dataset.issueSummary
    if (key) showContextMenu(e, key, summary)
  })
  registerContextMenu('.log-row[data-issue-key]', (e, row) => {
    const key = row.dataset.issueKey
    const summary = row.dataset.issueSummary
    if (key) showContextMenu(e, key, summary)
  })
  registerContextMenu('.favorite-item[data-issue-key]', (e, row) => {
    const key = row.dataset.issueKey
    const summary = row.dataset.issueSummary
    if (key) showContextMenu(e, key, summary)
  })

  installGlobalDelegation()
}

// ========== 타이머 업데이트 ==========
// active 세션이 하나도 없으면 인터벌 자체를 띄우지 않음 — 매초 querySelectorAll 비용 회피.
// active 카드 자체가 dataset.segments JSON을 매초 파싱하지 않도록 element 프로퍼티에 한 번만 캐싱.
export function startTimerUpdate() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval)
    state.timerInterval = null
  }

  const activeEls = []
  document.querySelectorAll('.session-timer').forEach(el => {
    if (el.dataset.status !== 'active' || !el.dataset.segments) return
    try {
      // 매초 파싱하지 않도록 원본 dataset를 element 프로퍼티에 1회 캐싱
      el._segments = JSON.parse(el.dataset.segments)
      activeEls.push(el)
    } catch {}
  })

  if (activeEls.length === 0) return

  state.timerInterval = setInterval(() => {
    const now = Date.now()
    for (const el of activeEls) {
      // DOM에서 떨어진 element는 정리 후 다음 render 사이클에 재구성됨
      if (!el.isConnected) continue
      let totalMs = 0
      for (const seg of el._segments) {
        const end = seg.end || now
        totalMs += end - seg.start
      }
      el.textContent = formatMinutes(Math.floor(totalMs / 60000))
    }
  }, 1000)
}
