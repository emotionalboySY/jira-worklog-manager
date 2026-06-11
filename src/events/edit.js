// 작업 로그 수정 / 삭제 모달 이벤트 바인딩.
import { state } from '../state.js'
import { createWorklog, updateWorklog, deleteWorklog } from '../jira.js'
import { showToast } from '../ui.js'
import {
  buildWorklogSegments,
  formatJiraError,
  withSpinner,
  shiftDate,
} from '../utils.js'
import {
  invalidateWorklogMonth,
  updateEditDurationReadout,
  computeDurationFromTimes,
} from '../views/modals.js'
import { render } from '../render.js'
import { on } from './_dom.js'

export function bindEditWorklogEvents() {
  // 취소
  const editCancel = document.getElementById('edit-worklog-cancel')
  if (editCancel) {
    on(editCancel, 'click', () => { state.editingWorklog = null; render({ sections: ['modals'] }) })
  }

  // '지금' 버튼
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

  // 시작/종료 시간 변경 → 실시간 계산
  const editStartInput = document.getElementById('edit-start-time')
  const editEndInput = document.getElementById('edit-end-time')
  if (editStartInput) on(editStartInput, 'input', updateEditDurationReadout)
  if (editEndInput) on(editEndInput, 'input', updateEditDurationReadout)
  if (editStartInput || editEndInput) updateEditDurationReadout()

  // 제출
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
        // 자정을 넘긴 기록은 다음 날(다음 달일 수 있음) 월 캐시도 무효화
        if (dur.crossesMidnight) {
          const next = shiftDate(savedDate, 1)
          if (next.substring(0, 7) !== savedDate.substring(0, 7)) invalidateWorklogMonth(next)
        }
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
}

// 삭제 확인 모달 (ESC 또는 버튼으로만 닫힘)
export function bindDeleteWorklogEvents() {
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
