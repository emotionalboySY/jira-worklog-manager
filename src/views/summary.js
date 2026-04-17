// 요약 탭
import { state } from '../state.js'
import { isLoggedIn } from '../auth.js'
import { loadWorklogs } from '../data.js'
import { getDayOff, getDayOffLabel } from '../storage.js'
import {
  toDateString,
  formatMinutes,
  getActiveLogs,
  getLogMinutes,
} from '../utils.js'

// 주어진 오프셋의 목요일 구하기 (0=이번 주, -1=지난 주, ...)
export function getThursdayByOffset(offset) {
  const today = new Date()
  const dayOfWeek = today.getDay()
  const diffToThursday = (dayOfWeek < 4) ? dayOfWeek + 3 : dayOfWeek - 4
  const thursday = new Date(today)
  thursday.setDate(today.getDate() - diffToThursday + offset * 7)
  return thursday
}

// 목요일 기준 주차 계산: 해당 월의 첫 번째 목요일 포함 주 = 1주차
export function getWeekOfMonth(thursday) {
  const month = thursday.getMonth()
  const year = thursday.getFullYear()
  const firstDay = new Date(year, month, 1)
  const firstDow = firstDay.getDay()
  const firstThursday = 1 + ((4 - firstDow + 7) % 7)
  return Math.floor((thursday.getDate() - firstThursday) / 7) + 1
}

// 목요일~수요일 주간 데이터 생성 (실제 worklog 기반)
export function getWeekData(offset) {
  const today = new Date()
  const thursday = getThursdayByOffset(offset)
  const days = ['일', '월', '화', '수', '목', '금', '토']
  const weekData = []

  for (let i = 0; i < 7; i++) {
    const d = new Date(thursday)
    d.setDate(thursday.getDate() + i)
    const dateStr = toDateString(d)
    const minutes = getLogMinutes(dateStr)
    const dayOffType = getDayOff(dateStr)
    const isToday = d.toDateString() === today.toDateString()
    const isFuture = d > today
    const dow = d.getDay()
    weekData.push({
      day: days[dow],
      date: `${String(d.getMonth() + 1).padStart(2, '0')}월 ${String(d.getDate()).padStart(2, '0')}일`,
      dateStr,
      minutes: isFuture ? 0 : minutes,
      dayOffType: isFuture ? null : dayOffType,
      today: isToday,
      isFuture,
      weekend: dow === 0 || dow === 6,
    })
  }
  return { weekData, thursday }
}

// 요약 탭에 필요한 월들의 워크로그 로딩
export function ensureSummaryWorklogs() {
  if (!isLoggedIn() || !state.issuesLoaded) return
  const thursday = getThursdayByOffset(state.summaryWeekOffset)
  const wednesday = new Date(thursday)
  wednesday.setDate(thursday.getDate() + 6)
  loadWorklogs(thursday.getFullYear(), thursday.getMonth())
  if (wednesday.getMonth() !== thursday.getMonth()) {
    loadWorklogs(wednesday.getFullYear(), wednesday.getMonth())
  }
}

export function renderSummaryTab() {
  const isCurrentWeek = state.summaryWeekOffset === 0
  const { weekData, thursday } = getWeekData(state.summaryWeekOffset)
  const totalWeekMinutes = weekData.reduce((sum, d) => sum + d.minutes, 0)
  const workedDays = weekData.filter(d => d.minutes > 0).length
  const avgMinutes = workedDays > 0 ? Math.round(totalWeekMinutes / workedDays) : 0

  const weekMonth = thursday.getMonth() + 1
  const weekNum = getWeekOfMonth(thursday)

  // 현재 주일 때만 오늘 카드 표시
  let todayCard = ''
  if (isCurrentWeek) {
    const todayStr = toDateString(new Date())
    const todayMinutes = getLogMinutes(todayStr)
    const todayLogs = getActiveLogs(todayStr)
    todayCard = `
      <div class="summary-card">
        <div class="summary-card-label">오늘</div>
        <div class="summary-card-value">${todayMinutes > 0 ? formatMinutes(todayMinutes) : '-'}</div>
        <div class="summary-card-sub">${todayLogs.length > 0 ? `${todayLogs.length}개 작업 기록` : '아직 기록 없음'}</div>
      </div>
    `
  }

  return `
    <div class="summary-week-nav">
      <button class="btn btn-sm" id="summary-prev">◀</button>
      <span class="summary-week-title">${weekMonth}월 ${weekNum}주차</span>
      ${state.worklogsLoading ? '<span class="calendar-spinner"></span>' : ''}
      <button class="btn btn-sm ${isCurrentWeek ? 'btn-disabled' : ''}" id="summary-next" ${isCurrentWeek ? 'disabled' : ''}>▶</button>
      ${!isCurrentWeek ? `<button class="btn btn-primary btn-sm" id="summary-this-week">이번 주</button>` : ''}
    </div>
    <div class="summary-grid ${isCurrentWeek ? '' : 'two-col'}">
      ${todayCard}
      <div class="summary-card">
        <div class="summary-card-label">${isCurrentWeek ? '이번 주' : '주간 합계'}</div>
        <div class="summary-card-value">${totalWeekMinutes > 0 ? formatMinutes(totalWeekMinutes) : '-'}</div>
        <div class="summary-card-sub">${workedDays > 0 ? `${workedDays}일 작업 기록` : '기록 없음'}</div>
      </div>
      <div class="summary-card">
        <div class="summary-card-label">일 평균</div>
        <div class="summary-card-value">${workedDays > 0 ? formatMinutes(avgMinutes) : '-'}</div>
        <div class="summary-card-sub">${isCurrentWeek ? '이번 주 기준' : '해당 주 기준'}</div>
      </div>
    </div>
    <div class="weekly-chart">
      <div class="weekly-chart-title">${isCurrentWeek ? '금주' : ''}(${weekMonth}월 ${weekNum}주차) 일별 작업 시간</div>
      <div class="chart-bars">
        ${weekData.map(d => `
          <div class="chart-bar-col ${d.isFuture ? 'future' : ''} ${d.weekend ? 'weekend' : ''} ${!d.isFuture ? 'clickable' : ''}" ${!d.isFuture ? `data-chart-date="${d.dateStr}" title="${d.date} 기록 보기"` : ''}>
            <span class="chart-bar-value">${d.minutes > 0 ? formatMinutes(d.minutes) : '-'}</span>
            <div class="chart-bar-track">
              <div class="chart-bar ${d.today ? 'today' : ''}" style="height: ${Math.max(Math.min((d.minutes / 480) * 100, 100), d.minutes > 0 ? 2 : 0)}%"></div>
            </div>
            <span class="chart-bar-label">${d.date} (${d.day})</span>
            ${d.dayOffType
              ? `<span class="chart-day-off-badge day-off-${d.dayOffType}" title="${getDayOffLabel(d.dayOffType)}">${getDayOffLabel(d.dayOffType)}</span>`
              : `<span class="chart-day-off-badge placeholder" aria-hidden="true">·</span>`
            }
          </div>
        `).join('')}
      </div>
    </div>
  `
}
