// 작업 로그 기록 탭
import { state } from '../state.js'
import { getDayOff, getDayOffLabel } from '../storage.js'
import {
  toDateString,
  escapeHtml,
  formatMinutes,
  formatHoursShort,
  getActiveLogs,
  getLogMinutes,
  renderIssueKeyLink,
  getProjectFromKey,
} from '../utils.js'

export function renderLogsTab() {
  return `
    <div class="log-toolbar">
      <button class="btn btn-sm btn-refresh" id="btn-refresh-worklogs" ${state.worklogsLoading ? 'disabled' : ''} title="작업 로그 새로고침">
        ${state.worklogsLoading ? '<span class="btn-spinner"></span>' : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8A5.5 5.5 0 1 1 12 4.5"/><polyline points="13.5 2 13.5 5 10.5 5"/></svg>'}
      </button>
      <button class="btn btn-sm" id="btn-calendar-toggle" title="${state.calendarOpen ? '달력 닫기' : '달력 열기'}">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="12" height="11" rx="1.5"/><line x1="2" y1="6.5" x2="14" y2="6.5"/><line x1="5.5" y1="1.5" x2="5.5" y2="4.5"/><line x1="10.5" y1="1.5" x2="10.5" y2="4.5"/></svg>
        <span>${state.calendarOpen ? '달력 닫기' : '달력 열기'}</span>
      </button>
    </div>
    ${state.calendarOpen ? renderCalendarView() : ''}
    ${renderDateNav()}
    ${renderLogDetail()}
  `
}

export function renderCalendarView() {
  const todayStr = toDateString(new Date())

  // 해당 월의 첫날과 마지막날
  const firstDay = new Date(state.calendarYear, state.calendarMonth, 1)
  const lastDay = new Date(state.calendarYear, state.calendarMonth + 1, 0)

  // 일요일 기준 시작 요일
  const dayHeaders = ['일', '월', '화', '수', '목', '금', '토']
  const thuOffset = firstDay.getDay() // 일요일=0 기준 오프셋

  // 미래 월 방지
  const now = new Date()
  const isCurrentMonth = state.calendarYear === now.getFullYear() && state.calendarMonth === now.getMonth()
  const isFutureMonth = state.calendarYear > now.getFullYear() || (state.calendarYear === now.getFullYear() && state.calendarMonth > now.getMonth())

  const cells = []
  // 이전 달 빈 셀
  for (let i = 0; i < thuOffset; i++) {
    cells.push({ day: '', dateStr: '', empty: true })
  }
  // 해당 월 날짜 셀
  for (let d = 1; d <= lastDay.getDate(); d++) {
    const dateStr = `${state.calendarYear}-${String(state.calendarMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const minutes = getLogMinutes(dateStr)
    const dayOffType = getDayOff(dateStr)
    const isFuture = dateStr > todayStr
    cells.push({
      day: d,
      dateStr,
      minutes,
      dayOffType,
      isToday: dateStr === todayStr,
      isSelected: dateStr === state.logDate,
      isFuture,
      empty: false,
    })
  }

  return `
    <div class="calendar">
      <div class="calendar-header">
        <button class="btn btn-sm" id="cal-prev">◀</button>
        <div class="calendar-selectors">
          <select class="calendar-select" id="cal-year">
            ${(() => {
              const nowY = new Date().getFullYear()
              let opts = ''
              for (let y = nowY - 2; y <= nowY; y++) {
                opts += `<option value="${y}" ${y === state.calendarYear ? 'selected' : ''}>${y}년</option>`
              }
              return opts
            })()}
          </select>
          <select class="calendar-select" id="cal-month">
            ${(() => {
              const nowY = new Date().getFullYear()
              const nowM = new Date().getMonth()
              let opts = ''
              for (let m = 0; m < 12; m++) {
                const disabled = state.calendarYear === nowY && m > nowM
                opts += `<option value="${m}" ${m === state.calendarMonth ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${m + 1}월</option>`
              }
              return opts
            })()}
          </select>
        </div>
        ${state.worklogsLoading ? '<span class="calendar-spinner"></span>' : ''}
        <button class="btn btn-sm ${isFutureMonth || isCurrentMonth ? 'btn-disabled' : ''}" id="cal-next" ${isFutureMonth || isCurrentMonth ? 'disabled' : ''}>▶</button>
        ${!(isCurrentMonth && state.logDate === todayStr) ? `<button class="btn btn-primary btn-sm" id="cal-today">오늘</button>` : ''}
      </div>
      <div class="calendar-grid">
        ${dayHeaders.map(d => `<div class="calendar-weekday">${d}</div>`).join('')}
        ${cells.map(cell => {
          if (cell.empty) return `<div class="calendar-cell empty"></div>`
          const level = cell.isFuture ? 0 : cell.minutes <= 0 ? 0 : cell.minutes < 180 ? 1 : cell.minutes < 360 ? 2 : 3
          const dayOffClass = cell.dayOffType ? `day-off day-off-${cell.dayOffType}` : ''
          return `
            <div class="calendar-cell ${cell.isToday ? 'today' : ''} ${cell.isSelected ? 'selected' : ''} ${cell.isFuture ? 'future' : ''} level-${level} ${dayOffClass}"
                 ${!cell.isFuture ? `data-cal-date="${cell.dateStr}"` : ''}
                 ${cell.dayOffType ? `title="${getDayOffLabel(cell.dayOffType)}"` : ''}>
              <span class="calendar-day">${cell.day}</span>
              ${cell.minutes > 0 ? `<span class="calendar-hours">${formatHoursShort(cell.minutes)}</span>` : ''}
            </div>
          `
        }).join('')}
      </div>
    </div>
  `
}

export function renderDateNav() {
  const todayStr = toDateString(new Date())
  return `
    <div class="log-date-nav">
      <button class="btn btn-sm" id="log-prev">◀</button>
      <input type="text" class="log-date-picker-input" id="log-date-picker" readonly />
      <button class="btn btn-sm ${state.logDate >= todayStr ? 'btn-disabled' : ''}" id="log-next" ${state.logDate >= todayStr ? 'disabled' : ''}>▶</button>
      ${state.logDate !== todayStr ? `<button class="btn btn-primary btn-sm" id="log-today">오늘</button>` : ''}
    </div>
  `
}

export function renderDayOffToggle() {
  const current = getDayOff(state.logDate)
  const options = [
    { value: 'none', label: '없음' },
    { value: 'full', label: '연차' },
    { value: 'am', label: '오전 반차' },
    { value: 'pm', label: '오후 반차' },
  ]
  return `
    <div class="day-off-toggle">
      <span class="day-off-label">연반차</span>
      <div class="day-off-options">
        ${options.map(o => `
          <button class="day-off-btn ${(current || 'none') === o.value ? 'active' : ''}" data-day-off="${o.value}">${o.label}</button>
        `).join('')}
      </div>
    </div>
  `
}

export function renderLogDetail() {
  const logs = getActiveLogs(state.logDate)
  const totalMinutes = getLogMinutes(state.logDate)

  return `
    <div class="log-detail">
      ${renderDayOffToggle()}
      ${state.worklogsLoading && logs.length === 0 ? `
        <div class="loading-container">
          <div class="loading-spinner"></div>
          <span class="loading-text">작업 로그를 불러오는 중</span>
        </div>
      ` : logs.length === 0 ? `
        <div class="no-session">이 날짜에 기록된 작업 로그가 없습니다.</div>
      ` : `
        <div class="log-list show-project-bar">
          ${logs.map((log, idx) => `
            <div class="log-row" data-issue-key="${log.issueKey}" data-issue-summary="${escapeHtml(log.summary || '')}" data-project="${getProjectFromKey(log.issueKey)}">
              <span class="log-time-range">${log.startTime} → ${log.endTime}</span>
              <span class="log-duration">${log.durationMinutes != null ? formatMinutes(log.durationMinutes) : log.duration}</span>
              <div class="log-issue">
                <div class="log-issue-header">
                  ${renderIssueKeyLink(log.issueKey)}
                  <span class="issue-summary">${escapeHtml(log.summary || '')}</span>
                  ${log.lunchDeducted > 0 ? `<span class="log-lunch-badge">점심 -${log.lunchDeducted}분</span>` : ''}
                </div>
                ${log.comment ? `<span class="log-comment">${escapeHtml(log.comment)}</span>` : ''}
              </div>
              ${log.worklogId ? `
                <div class="log-actions">
                  <button class="btn btn-sm" data-action="edit-log" data-idx="${idx}">수정</button>
                  <button class="btn btn-sm btn-danger" data-action="delete-log" data-idx="${idx}">삭제</button>
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
        <div class="log-summary">
          <span class="log-summary-label">총 작업 시간</span>
          <span class="log-summary-value">${formatMinutes(totalMinutes)}</span>
        </div>
      `}
    </div>
  `
}
