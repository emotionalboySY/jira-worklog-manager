// 요약 탭 주차 네비게이션 (이전/다음/이번 주).
import { state } from '../state.js'
import { ensureSummaryWorklogs } from '../views/summary.js'
import { render } from '../render.js'
import { on } from './_dom.js'

export function bindSummaryNavEvents() {
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
}
