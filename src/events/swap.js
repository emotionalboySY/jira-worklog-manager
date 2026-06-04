// 일감 교체 모달 이벤트 바인딩.
// 종료 모달이 떠 있는 동안 동일 세션의 일감을 다른 이슈로 교체할 때 사용.
import { state } from '../state.js'
import { fetchIssueMeta } from '../jira.js'
import { swapSessionIssue } from '../storage.js'
import { showToast } from '../ui.js'
import {
  isValidIssueKeyFormat,
  findLoadedIssue,
  renderKeyHint,
  updateKeyDropdown,
  SWAP_KEY_CTX,
} from '../views/modals.js'
import { render } from '../render.js'
import { on } from './_dom.js'
import { bindKeyDropdownNav } from './_keynav.js'

export function bindSwapModalEvents() {
  // 취소
  const swapCancel = document.getElementById('swap-issue-cancel')
  if (swapCancel) {
    on(swapCancel, 'click', () => {
      state.showSwapIssue = null
      state.swapIssueCheck = null
      render({ sections: ['modals'] })
    })
  }

  // 이슈 키 입력 (자동완성 + blur 검증)
  const swapInput = document.getElementById('swap-issue-key')
  if (swapInput) {
    // 모달이 처음 뜰 때 입력칸에 자동 포커스 (모달당 1회만)
    if (state.showSwapIssue && !state.showSwapIssue._focused) {
      swapInput.focus()
      state.showSwapIssue._focused = true
    }
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

  // 제출
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
}
