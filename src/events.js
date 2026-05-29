// events.js — 글로벌 ESC/click 리스너 + bindEvents 오케스트레이터 + 이벤트 위임 1회 등록 + 타이머.
// 도메인별 핸들러는 events/* 하위 파일들로 분리되어 있다.
import { state } from './state.js'
import { isLoggedIn } from './auth.js'
import {
  fetchTransitions,
  fetchIssueTypes,
  fetchActiveSprintIssueKeys,
  getCachedTransitions,
  setCachedTransitions,
  getCachedAssignableUsers,
  getCachedIssueTypes,
  setCachedIssueTypes,
} from './jira.js'
import { getEditorOnMount, runCommandOnEditor } from './tiptap.js'
import {
  loadSessions,
  adjustSessionStart,
  addSession,
  pauseSession,
  resumeSession,
  removeSession,
  deleteSessionSegment,
  setDayOff,
  toggleFavorite,
} from './storage.js'
import {
  toDateString,
  getActiveIssues,
  getActiveLogs,
  formatMinutes,
  formatJiraError,
} from './utils.js'
import { showToast, showContextMenu } from './ui.js'
import { loadWorklogs, ensureMonthWorklogsLoaded } from './actions.js'
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
  cancelIssueDetailEdit,
  openIssueDetailModal,
  bindDetailModalEvents,
  detailLinkActions,
} from './events/detail.js'
import {
  closeAssigneeDropdown,
  refreshAssigneeDropdownList,
  loadAssignableUsers,
  applyAssigneeChange,
  performTypeChange,
  performTransition,
} from './events/dropdowns.js'
import { bindSettingsEvents, closeSettings } from './events/settings.js'
import { bindHeaderEvents } from './events/header.js'
import { bindCalendarEvents } from './events/calendar.js'
import { bindFinishModalEvents, bindCancelConfirmEvents } from './events/finish.js'
import { bindSwapModalEvents } from './events/swap.js'
import { bindManualModalEvents } from './events/manual.js'
import { bindEditWorklogEvents, bindDeleteWorklogEvents } from './events/edit.js'
import { bindTransitionFieldsEvents } from './events/transition.js'
import { bindSummaryNavEvents } from './events/summary.js'
import { ensureSummaryWorklogs } from './views/summary.js'

// ESC 키로 가장 위(나중에 열린) 모달 닫기.
// 오버레이 바깥 클릭 닫기는 textarea 드래그 선택이 밖에서 끝날 때 오탐하므로 제거.
// 취소/X 버튼과 ESC로만 닫는다.
let globalKeyListenerRegistered = false
let globalClickListenerRegistered = false

// bindKeyDropdownNav는 events/_keynav.js로 분리됨

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
// 매 render 종료 시점에 호출 (render.js의 post-render hook). 도메인별 sub-binder를 순차 호출.
// 글로벌 ESC/click 리스너는 첫 호출에서 1회만 등록.
export function bindEvents() {
  // 전역 리스너 (1회 등록)
  if (!globalKeyListenerRegistered) {
    on(document, 'keydown', handleGlobalKeydown)
    globalKeyListenerRegistered = true
  }
  if (!globalClickListenerRegistered) {
    on(document, 'click', handleGlobalClick)
    globalClickListenerRegistered = true
  }

  // ===== 도메인별 sub-binder =====
  bindHeaderEvents()
  bindSettingsEvents()
  bindCalendarEvents()
  bindCreateIssueEvents()
  ensureCreateIssueEditor()
  bindDetailModalEvents()
  bindCommentEvents()
  ensureCommentEditors()
  bindFinishModalEvents()
  bindCancelConfirmEvents()
  bindSwapModalEvents()
  bindManualModalEvents()
  bindEditWorklogEvents()
  bindDeleteWorklogEvents()
  bindTransitionFieldsEvents()
  bindSummaryNavEvents()

  // ===== 잔여 element 핸들러 — 단일 element + 특수 처리 =====

  // 플로팅 즐겨찾기 패널 토글.
  // e.stopPropagation으로 element 단계에서 bubble을 막아 handleGlobalClick의
  // 자동 닫힘(panel.contains(e.target) 검사 실패로 인한)을 차단한다.
  const favToggle = document.getElementById('favorites-toggle')
  if (favToggle) {
    on(favToggle, 'click', (e) => {
      e.stopPropagation()
      if (state.favoritesPanelCollapsed) {
        state.favoritesPanelCollapsed = false
        localStorage.setItem('favorites_collapsed', '0')
        render({ sections: ['favorites'] })
      } else {
        closeFavoritesPanel()
      }
    })
  }

  // 담당자 드롭다운: 검색 input + 리스트 항목 클릭 위임 (드롭다운 DOM 내부, 부분 갱신 보존)
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

  // 이슈 목록 스크롤 → 상태 드롭다운 닫기 (scroll은 bubble 안 함 — document 위임 불가)
  const issueListEl = document.querySelector('.issue-list')
  if (issueListEl) {
    on(issueListEl, 'scroll', () => {
      if (state.statusDropdown) {
        state.statusDropdown = null
        render({ sections: ['modals'] })
      }
    })
  }

  // tiptap 툴바 (본문 + 댓글 작성기 + 댓글 편집기 모두 동일 핸들러).
  // 같은 .tiptap-toolbar 요소가 여러 곳에 떠 있을 수 있어 위임보다 toolbar 단위 바인딩이 자연스러움.
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

  // 상세 모달의 연결 항목 관련 액션 (열기 전환 / 해제 / 추가 선택)
  for (const [action, handler] of Object.entries(detailLinkActions)) {
    registerClickAction(action, handler)
  }

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
    adjustSessionStart(key, newStart.getTime())
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
