// 수동 작업 기록 모달 이벤트 바인딩.
// 버튼 클릭으로 모달 열기 + 모달 내부 이슈 키/시간 입력 + Jira 기록 제출.
import { state } from '../state.js'
import { fetchIssueMeta, createWorklog } from '../jira.js'
import { showToast } from '../ui.js'
import {
  buildWorklogSegments,
  formatJiraError,
  shiftDate,
} from '../utils.js'
import {
  isValidIssueKeyFormat,
  findLoadedIssue,
  getLatestEndTimeForDate,
  invalidateWorklogMonth,
  updateManualDurationReadout,
  computeDurationFromTimes,
  renderManualKeyHint,
  updateManualKeyDropdown,
  MANUAL_KEY_CTX,
  readModalLunch,
  bindLunchFieldEvents,
} from '../views/modals.js'
import { ensureMonthWorklogsLoaded } from '../actions.js'
import { render } from '../render.js'
import { on } from './_dom.js'
import { bindKeyDropdownNav } from './_keynav.js'

export function bindManualModalEvents() {
  // 수동 기록 진입 버튼 (현재 작업 카드 상단)
  const manualLogBtn = document.getElementById('btn-manual-log')
  if (manualLogBtn) {
    on(manualLogBtn, 'click', () => {
      state.showManualLog = {}
      state.manualIssueCheck = null
      render({ sections: ['modals'] })
    })
  }

  // 취소
  const manualCancel = document.getElementById('manual-log-cancel')
  if (manualCancel) {
    on(manualCancel, 'click', () => {
      state.showManualLog = null
      state.manualIssueCheck = null
      render({ sections: ['modals'] })
    })
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
    bindKeyDropdownNav(manualIssueInput, {
      dropdownId: 'manual-key-dropdown',
      activeIdxKey: 'manualKeyActiveIdx',
      selectCtx: MANUAL_KEY_CTX,
    })

    // blur: 유효성 검사 (폼 초기화 방지 위해 render() 대신 힌트 DOM 직접 업데이트)
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

  // 시작 시간 사용자 수정 추적: 자동 채움을 해제
  const manualStartInputEl = document.getElementById('manual-start-time')
  if (manualStartInputEl) {
    on(manualStartInputEl, 'input', () => {
      manualStartInputEl.dataset.autofilled = '0'
    })
  }

  // 모달 열린 직후: 비동기 자동 채움
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
  // 점심시간(시작/종료/차감 안 함) 변경 → 소요 시간 실시간 갱신
  bindLunchFieldEvents(document.getElementById('manual-log-overlay'), updateManualDurationReadout)
  if (manualStartInput || manualEndInput) updateManualDurationReadout()

  // 제출
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

      // 이 모달에서 지정/덮어쓴 점심시간 ('차감 안 함'이면 차감 없음)
      const lunch = readModalLunch(document.getElementById('manual-log-overlay'))
      const dur = computeDurationFromTimes(startTime, endTime, lunch)
      if (!dur.valid) { alert(dur.message); return }

      // 점심시간이 겹치면 두 개 구간으로 쪼개서 기록 (종료 시간 유지를 위해)
      const segments = buildWorklogSegments(date, startTime, endTime, lunch)
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
        // 자정을 넘긴 기록은 다음 날(다음 달일 수 있음) 월 캐시도 무효화
        if (dur.crossesMidnight) {
          const next = shiftDate(date, 1)
          if (next.substring(0, 7) !== date.substring(0, 7)) invalidateWorklogMonth(next)
        }
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
}

// 선택된 날짜의 마지막 worklog endTime으로 시작 시간을 자동 채움.
// 사용자가 수동 수정한 경우(dataset.autofilled === '0') 덮어쓰지 않음.
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
  if (startInput.dataset.autofilled === '0') return
  startInput.value = latestEnd
  startInput.dataset.autofilled = '1'
  updateManualDurationReadout()
}
