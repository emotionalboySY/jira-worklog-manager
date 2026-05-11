// 이슈 상태 전이 — 필수 추가 필드(예: resolution)가 있는 전이를 위한 2차 모달.
// 단순 전이는 events/dropdowns.js의 apply-transition 액션이 처리.
import { state } from '../state.js'
import { buildTransitionFieldsPayload } from '../views/modals.js'
import { performTransition } from './dropdowns.js'
import { render } from '../render.js'
import { on } from './_dom.js'

export function bindTransitionFieldsEvents() {
  // 입력값을 state.values에 실시간 반영 (재렌더로 값 날아가지 않도록)
  document.querySelectorAll('.transition-field').forEach(input => {
    on(input, 'input', () => {
      if (!state.transitionFieldsModal) return
      const key = input.dataset.fieldKey
      state.transitionFieldsModal.values[key] = input.value
    })
    on(input, 'change', () => {
      if (!state.transitionFieldsModal) return
      const key = input.dataset.fieldKey
      state.transitionFieldsModal.values[key] = input.value
    })
  })

  // 취소
  const transitionFieldsCancel = document.getElementById('transition-fields-cancel')
  if (transitionFieldsCancel) {
    on(transitionFieldsCancel, 'click', () => {
      if (state.transitionFieldsModal?.submitting) return
      state.transitionFieldsModal = null
      render({ sections: ['modals'] })
    })
  }

  // 제출
  const transitionFieldsSubmit = document.getElementById('transition-fields-submit')
  if (transitionFieldsSubmit) {
    on(transitionFieldsSubmit, 'click', async () => {
      const ctx = state.transitionFieldsModal
      if (!ctx || ctx.submitting) return
      const { issueKey, transition, values } = ctx
      // 필수 필드 검증
      const missing = Object.entries(transition.fields || {})
        .filter(([, f]) => f.required)
        .filter(([key]) => {
          const v = values[key]
          return v === undefined || v === null || v === ''
        })
      if (missing.length > 0) {
        alert(`다음 필드를 입력해주세요:\n- ${missing.map(([, f]) => f.name || '-').join('\n- ')}`)
        return
      }
      ctx.submitting = true
      render({ sections: ['modals'] })
      const fieldsPayload = buildTransitionFieldsPayload(transition, values)
      await performTransition(issueKey, transition, fieldsPayload)
      state.transitionFieldsModal = null
      render({ sections: ['modals'] })
    })
  }
}
