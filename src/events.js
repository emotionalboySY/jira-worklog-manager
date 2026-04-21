// 전체 이벤트 바인딩 + 타이머 업데이트
import flatpickr from 'flatpickr'
import { Korean } from 'flatpickr/dist/l10n/ko.js'
import { state, NO_ISSUE_KEY, NO_ISSUE_SUMMARY } from './state.js'
import { logout, isLoggedIn } from './auth.js'
import {
  fetchIssueMeta,
  fetchActiveSprintIssueKeys,
  createWorklog,
  updateWorklog,
  deleteWorklog,
} from './jira.js'
import {
  loadSessions,
  saveSessions,
  addSession,
  pauseSession,
  resumeSession,
  removeSession,
  setDayOff,
  toggleFavorite,
  loadPreferences,
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
} from './utils.js'
import { toggleTheme, showToast, showContextMenu, applyPreferences } from './ui.js'
import {
  loadWorklogs,
  ensureMonthWorklogsLoaded,
  refreshIssues,
  refreshWorklogs,
  performSearch,
} from './data.js'
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
  FINISH_KEY_CTX,
  renderKeyHint,
  updateKeyDropdown,
  selectKeyCandidate,
} from './views/modals.js'
import { ensureSummaryWorklogs } from './views/summary.js'
import { render } from './render.js'

// 중복 바인딩 방지 헬퍼.
// 부분 렌더링 도입 후 bindEvents가 여러 번 호출돼도 동일 element에 같은 이벤트는 한 번만 바인드.
// element가 새로 생성되면 내부 프로퍼티가 없으므로 다시 바인드된다.
function on(el, event, handler, options) {
  if (!el) return
  const key = `__bound_${event}`
  if (el[key]) return
  el[key] = true
  el.addEventListener(event, handler, options)
}

// ESC 키로 가장 위(나중에 열린) 모달 닫기.
// 오버레이 바깥 클릭 닫기는 textarea 드래그 선택이 밖에서 끝날 때 오탐하므로 제거.
// 취소/X 버튼과 ESC로만 닫는다.
let globalKeyListenerRegistered = false
let globalClickListenerRegistered = false

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
    if (state.editingWorklog) submitBtn = document.getElementById('edit-worklog-submit')
    else if (state.showManualLog) submitBtn = document.getElementById('manual-log-submit')
    else if (state.showModal) submitBtn = document.getElementById('modal-submit')
    if (submitBtn && !submitBtn.disabled) {
      e.preventDefault()
      submitBtn.click()
    }
    return
  }
  if (e.key !== 'Escape') return
  const modalsOnly = { sections: ['modals'] }
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
}

// ========== 설정 모달 헬퍼 ==========
function closeSettings() {
  // 저장 전이라면 실제 적용된 prefs(state.userPrefs)로 CSS 변수 되돌림 (미리보기 롤백)
  applyPreferences(state.userPrefs)
  state.showSettings = false
  state.settingsDraft = null
  render({ sections: ['modals', 'settings-fab'] })
}

function hexToRgb(hex) {
  const h = (hex || '').replace('#', '')
  if (h.length !== 6) return { r: 99, g: 102, b: 241 } // accent 기본
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  }
}

// base hex → { bar, fg, bg } 파생. fg는 white에 30% 섞어 밝게, bg는 opacity 0.14
function deriveProjectColors(hex) {
  const { r, g, b } = hexToRgb(hex)
  const mix = (c) => Math.min(255, Math.round(c + (255 - c) * 0.3))
  const fg = `#${[mix(r), mix(g), mix(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`
  return {
    bar: hex,
    fg,
    bg: `rgba(${r}, ${g}, ${b}, 0.14)`,
  }
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

  // 작업 로그 새로고침
  const refreshWorklogsBtn = document.getElementById('btn-refresh-worklogs')
  if (refreshWorklogsBtn) {
    on(refreshWorklogsBtn, 'click', () => refreshWorklogs())
  }

  // 프로젝트 선택
  document.querySelectorAll('.project-chip').forEach(chip => {
    on(chip, 'click', () => {
      state.currentProject = chip.dataset.project
      state.currentFilterTab = 'all'
      state.currentPage = 1
      // 검색 모드 해제
      state.searchQuery = ''
      state.searchResults = null
      render()
    })
  })

  // 메인 탭
  document.querySelectorAll('.main-tab').forEach(tab => {
    on(tab, 'click', () => {
      state.currentMainTab = tab.dataset.mainTab
      if (tab.dataset.mainTab === 'logs' && isLoggedIn() && state.issuesLoaded) {
        loadWorklogs(state.calendarYear, state.calendarMonth)
      }
      if (tab.dataset.mainTab === 'summary') {
        ensureSummaryWorklogs()
      }
      render()
    })
  })

  // 필터 탭
  document.querySelectorAll('.filter-tab').forEach(tab => {
    on(tab, 'click', () => {
      state.currentFilterTab = tab.dataset.filter
      state.currentPage = 1
      // 검색 모드 해제
      state.searchQuery = ''
      state.searchResults = null
      render()
    })
  })

  // 이슈 검색
  const searchInput = document.getElementById('issue-search')
  if (searchInput) {
    let debounceTimer
    on(searchInput, 'input', (e) => {
      state.searchQuery = e.target.value
      clearTimeout(debounceTimer)
      if (!state.searchQuery.trim()) {
        state.searchResults = null
        state.searchLoading = false
        render()
        // 렌더 후 포커스 복원
        document.getElementById('issue-search')?.focus()
        return
      }
      debounceTimer = setTimeout(() => performSearch(), 500)
    })
    on(searchInput, 'keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(debounceTimer)
        performSearch()
      }
      if (e.key === 'Escape') {
        state.searchQuery = ''
        state.searchResults = null
        render()
      }
    })
  }

  const searchClearBtn = document.getElementById('search-clear')
  if (searchClearBtn) {
    on(searchClearBtn, 'click', () => {
      state.searchQuery = ''
      state.searchResults = null
      render()
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
    })
  }

  // 페이지 사이즈
  const pageSizeSelect = document.getElementById('page-size')
  if (pageSizeSelect) {
    on(pageSizeSelect, 'change', (e) => {
      state.pageSize = parseInt(e.target.value)
      state.currentPage = 1
      render()
    })
  }

  // 페이지네이션
  document.querySelectorAll('[data-page]').forEach(btn => {
    on(btn, 'click', () => {
      state.currentPage = parseInt(btn.dataset.page)
      render()
      // 이슈 목록 상단으로 스크롤
      document.querySelector('.issue-list')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  })

  // 연반차 토글
  document.querySelectorAll('[data-day-off]').forEach(btn => {
    on(btn, 'click', () => {
      const value = btn.dataset.dayOff
      setDayOff(state.logDate, value === 'none' ? null : value)
      render()
    })
  })

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
      state.calendarYear = parseInt(e.target.value)
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
      state.calendarMonth = parseInt(e.target.value)
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

  // 달력 날짜 클릭
  document.querySelectorAll('[data-cal-date]').forEach(cell => {
    on(cell, 'click', () => {
      state.logDate = cell.dataset.calDate
      render()
    })
  })

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

  const logDatePicker = document.getElementById('log-date-picker')
  if (logDatePicker) {
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

  // 이슈 행 우클릭 → 컨텍스트 메뉴
  document.querySelectorAll('.issue-row[data-issue-key]').forEach(row => {
    on(row, 'contextmenu', (e) => {
      const key = row.dataset.issueKey
      const summary = row.dataset.issueSummary
      if (key) showContextMenu(e, key, summary)
    })
  })

  // 작업 로그 상세 행 우클릭 → 컨텍스트 메뉴 (이슈 행과 동일)
  document.querySelectorAll('.log-row[data-issue-key]').forEach(row => {
    on(row, 'contextmenu', (e) => {
      const key = row.dataset.issueKey
      const summary = row.dataset.issueSummary
      if (key) showContextMenu(e, key, summary)
    })
  })

  // 즐겨찾기 별표 토글
  document.querySelectorAll('[data-action="toggle-favorite"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      const key = btn.dataset.key
      const pool = [...getActiveIssues(), ...(state.searchResults || [])]
      const issue = pool.find(i => i.key === key)
      toggleFavorite(key, issue?.summary || '')
      render()
    })
  })

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

  // 즐겨찾기 패널의 시작 버튼
  document.querySelectorAll('[data-action="fav-start"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      const key = btn.dataset.key
      const summary = btn.dataset.summary || ''
      addSession(key, summary)
      render()
    })
  })

  // 즐겨찾기 해제 (패널 내부)
  document.querySelectorAll('[data-action="fav-remove"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      const key = btn.dataset.key
      toggleFavorite(key, '')
      render()
    })
  })

  // 즐겨찾기 항목 우클릭 → 컨텍스트 메뉴
  document.querySelectorAll('.favorite-item[data-issue-key]').forEach(row => {
    on(row, 'contextmenu', (e) => {
      const key = row.dataset.issueKey
      const summary = row.dataset.issueSummary
      if (key) showContextMenu(e, key, summary)
    })
  })

  // 이슈 행 호버 시 표시되는 '수동 기록' 버튼
  document.querySelectorAll('[data-action="manual-log"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      const key = btn.dataset.key
      const pool = [...getActiveIssues(), ...(state.searchResults || [])]
      const issue = pool.find(i => i.key === key)
      if (!issue) return
      state.showManualLog = { issueKey: key, summary: issue.summary }
      state.manualIssueCheck = { status: 'ok', key, summary: issue.summary }
      render()
    })
  })

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

  // 이슈 목록에서 작업 시작
  document.querySelectorAll('[data-action="start"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      const key = btn.dataset.key
      // 이슈 목록 또는 검색 결과에서 찾기
      const allIssues = [...getActiveIssues(), ...(state.searchResults || [])]
      const issue = allIssues.find(i => i.key === key)
      if (issue) {
        addSession(key, issue.summary)
        render()
      }
    })
  })

  // 세션 시작 시간을 직전 로그 종료 시간으로 조정
  document.querySelectorAll('[data-action="adjust-session-start"]').forEach(btn => {
    on(btn, 'click', async (e) => {
      e.stopPropagation()
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
  })

  // 세션 중단
  document.querySelectorAll('[data-action="pause"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      pauseSession(btn.dataset.key)
      render()
    })
  })

  // 세션 재개
  document.querySelectorAll('[data-action="resume"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      resumeSession(btn.dataset.key)
      render()
    })
  })

  // 작업 종료 버튼 → 종료 모달
  document.querySelectorAll('[data-action="finish"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      state.showModal = btn.dataset.key
      state.finishIssueCheck = null
      state.finishKeyActiveIdx = -1
      render({ sections: ['modals'] })
    })
  })

  // 작업 취소 버튼 → 컨펌 모달
  document.querySelectorAll('[data-action="cancel"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      state.showCancelConfirm = btn.dataset.key
      render({ sections: ['modals'] })
    })
  })

  // 종료 모달은 ESC 또는 취소 버튼으로만 닫힘

  const modalCancel = document.getElementById('modal-cancel')
  if (modalCancel) {
    on(modalCancel, 'click', () => {
      state.showModal = null
      state.finishIssueCheck = null
      render({ sections: ['modals'] })
    })
  }

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
    on(finishIssueInput, 'keydown', (e) => {
      const dropdown = document.getElementById('finish-key-dropdown')
      if (!dropdown || dropdown.style.display === 'none') return
      const items = dropdown.querySelectorAll('.autocomplete-item')
      if (items.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        state.finishKeyActiveIdx = (state.finishKeyActiveIdx + 1) % items.length
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        state.finishKeyActiveIdx = (state.finishKeyActiveIdx - 1 + items.length) % items.length
      } else if (e.key === 'Enter' && !(e.ctrlKey || e.metaKey)) {
        // Enter만 누르면 드롭다운 선택, Ctrl+Enter는 제출 (전역 핸들러로 위임)
        if (state.finishKeyActiveIdx >= 0) {
          e.preventDefault()
          const el = items[state.finishKeyActiveIdx]
          selectKeyCandidate(FINISH_KEY_CTX, el.dataset.key, el.dataset.summary || '')
          return
        }
      } else if (e.key === 'Escape') {
        state.finishKeyActiveIdx = -1
        dropdown.style.display = 'none'
        dropdown.innerHTML = ''
        return
      } else {
        return
      }
      items.forEach((el, i) => el.classList.toggle('active', i === state.finishKeyActiveIdx))
      if (state.finishKeyActiveIdx >= 0) items[state.finishKeyActiveIdx].scrollIntoView({ block: 'nearest' })
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
    // 키보드 네비게이션
    on(manualIssueInput, 'keydown', (e) => {
      const dropdown = document.getElementById('manual-key-dropdown')
      if (!dropdown || dropdown.style.display === 'none') return
      const items = dropdown.querySelectorAll('.autocomplete-item')
      if (items.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        state.manualKeyActiveIdx = (state.manualKeyActiveIdx + 1) % items.length
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        state.manualKeyActiveIdx = (state.manualKeyActiveIdx - 1 + items.length) % items.length
      } else if (e.key === 'Enter' && !(e.ctrlKey || e.metaKey)) {
        // Enter만 누르면 드롭다운 선택, Ctrl+Enter는 전역 핸들러에서 제출
        if (state.manualKeyActiveIdx >= 0) {
          e.preventDefault()
          const el = items[state.manualKeyActiveIdx]
          selectManualKeyCandidate(el.dataset.key, el.dataset.summary || '')
          return
        }
      } else if (e.key === 'Escape') {
        state.manualKeyActiveIdx = -1
        dropdown.style.display = 'none'
        dropdown.innerHTML = ''
        return
      } else {
        return
      }
      items.forEach((el, i) => el.classList.toggle('active', i === state.manualKeyActiveIdx))
      if (state.manualKeyActiveIdx >= 0) items[state.manualKeyActiveIdx].scrollIntoView({ block: 'nearest' })
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

  // 요약 탭 일별 차트 막대 클릭 → 로그 탭으로 이동
  document.querySelectorAll('[data-chart-date]').forEach(col => {
    on(col, 'click', () => {
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
  })

  // 작업 로그 수정 버튼
  document.querySelectorAll('[data-action="edit-log"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      const idx = parseInt(btn.dataset.idx)
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
  })

  // 작업 로그 삭제 버튼
  document.querySelectorAll('[data-action="delete-log"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      const idx = parseInt(btn.dataset.idx)
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
  })

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
      // 버튼 스피너 + 중복 클릭 차단 (Jira 등록과 동일 패턴)
      const originalLabel = deleteYes.innerHTML
      deleteYes.disabled = true
      deleteYes.classList.add('is-loading')
      deleteYes.innerHTML = '<span class="btn-spinner"></span>'
      if (deleteNoBtn) deleteNoBtn.disabled = true
      try {
        await deleteWorklog(state.deletingWorklog.issueKey, state.deletingWorklog.worklogId)
        state.deletingWorklog = null
        // 성공 시 loadWorklogs → render가 호출되어 모달이 닫힘
        invalidateWorklogMonth(state.logDate)
      } catch (e) {
        console.error('작업 로그 삭제 실패:', e)
        alert(`작업 로그 삭제에 실패했습니다.\n\n${formatJiraError(e)}`)
        deleteYes.disabled = false
        deleteYes.classList.remove('is-loading')
        deleteYes.innerHTML = originalLabel
        if (deleteNoBtn) deleteNoBtn.disabled = false
      }
    })
  }
}

// ========== 타이머 업데이트 ==========
export function startTimerUpdate() {
  if (state.timerInterval) clearInterval(state.timerInterval)
  state.timerInterval = setInterval(() => {
    document.querySelectorAll('.session-timer').forEach(el => {
      if (el.dataset.status === 'active' && el.dataset.segments) {
        try {
          const segments = JSON.parse(el.dataset.segments)
          let totalMs = 0
          for (const seg of segments) {
            const end = seg.end || Date.now()
            totalMs += end - seg.start
          }
          const totalMinutes = Math.floor(totalMs / 60000)
          el.textContent = formatMinutes(totalMinutes)
        } catch {}
      }
    })
  }, 1000)
}
