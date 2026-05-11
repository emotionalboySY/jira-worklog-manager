// 로그 탭 달력 + 날짜 네비게이션 + flatpickr 인스턴스 관리.
import flatpickr from 'flatpickr'
import { Korean } from 'flatpickr/dist/l10n/ko.js'
import { state } from '../state.js'
import { isLoggedIn } from '../auth.js'
import { loadWorklogs } from '../actions.js'
import { toDateString, shiftDate } from '../utils.js'
import { render } from '../render.js'
import { on } from './_dom.js'

export function bindCalendarEvents() {
  // 달력 열기/닫기 토글
  // render()를 호출하면 log-body DOM이 교체되어 grid-template-columns transition이 실행되지 않는다.
  // 달력 DOM은 항상 렌더되므로, 기존 요소의 .with-calendar 클래스만 토글하여 transition 실행.
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

  // (달력 날짜 셀 클릭 [data-cal-date]는 events/_delegate.js로 위임됨)

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

  // flatpickr 인스턴스 — bindEvents()는 매 render마다 호출되므로 가드가 없으면
  // 부분 렌더(modals 등)에서도 매번 새로 생성되어 calendar DOM과 document 리스너가 누수된다.
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
}
