// 작업 종료 모달 + 취소 컨펌 모달 이벤트 바인딩.
// 이슈 키 입력(일감 미지정 세션) + 구간별 시간 input + Jira 기록 제출.
import { state, NO_ISSUE_KEY } from '../state.js'
import { fetchIssueMeta, createWorklog } from '../jira.js'
import { loadSessions, removeSession } from '../storage.js'
import { showToast } from '../ui.js'
import {
  buildWorklogSegments,
  formatLunchRange,
  formatJiraError,
  shiftDate,
} from '../utils.js'
import {
  isValidIssueKeyFormat,
  findLoadedIssue,
  invalidateWorklogMonth,
  updateFinishDurationReadouts,
  renderKeyHint,
  updateKeyDropdown,
  FINISH_KEY_CTX,
} from '../views/modals.js'
import { render } from '../render.js'
import { on } from './_dom.js'
import { bindKeyDropdownNav } from './_keynav.js'

export function bindFinishModalEvents() {
  // 취소 버튼
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

  // 구간별 시작/종료 시간 input → 실시간 소요 시간 readout 갱신
  document.querySelectorAll('.finish-seg-start, .finish-seg-end').forEach(inp => {
    on(inp, 'input', updateFinishDurationReadouts)
  })

  // 마지막 구간의 '지금' 버튼
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

  // 모달이 열려 있으면 초기 readout 채움
  if (document.getElementById('modal-overlay')) {
    updateFinishDurationReadouts()
  }

  // 제출 — Jira에 worklog 기록
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
        // 자정을 넘긴 구간은 다음 날(다음 달일 수 있음)에도 worklog가 생기므로 함께 무효화
        const dates = seg.crossesMidnight ? [seg.date, shiftDate(seg.date, 1)] : [seg.date]
        for (const d of dates) {
          const monthStart = `${d.substring(0, 7)}-01`
          if (!invalidatedMonths.has(monthStart)) {
            invalidatedMonths.add(monthStart)
            invalidateWorklogMonth(monthStart)
          }
        }
      }
      showToast(`Jira에 ${successCount}건 기록했습니다.`, '✓')
      render()
    })
  }
}

// 취소 컨펌 모달 (작업 취소 — 세션 삭제)
export function bindCancelConfirmEvents() {
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
}
