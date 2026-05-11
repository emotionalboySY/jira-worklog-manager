// 이슈 키 자동완성 드롭다운의 키보드 네비게이션 헬퍼.
// finish-issue-key / swap-issue-key / manual-issue-key 세 곳이 동일 구조라 통합.
// ctx: { dropdownId, activeIdxKey, selectCtx }  (selectCtx = selectKeyCandidate에 넘길 ctx)
import { state } from '../state.js'
import { selectKeyCandidate } from '../views/modals.js'
import { on } from './_dom.js'

export function bindKeyDropdownNav(input, ctx) {
  on(input, 'keydown', (e) => {
    const dropdown = document.getElementById(ctx.dropdownId)
    if (!dropdown || dropdown.style.display === 'none') return
    const items = dropdown.querySelectorAll('.autocomplete-item')
    if (items.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      state[ctx.activeIdxKey] = (state[ctx.activeIdxKey] + 1) % items.length
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      state[ctx.activeIdxKey] = (state[ctx.activeIdxKey] - 1 + items.length) % items.length
    } else if (e.key === 'Enter' && !(e.ctrlKey || e.metaKey)) {
      // Enter만 누르면 드롭다운 선택, Ctrl+Enter는 제출 (전역 핸들러로 위임)
      if (state[ctx.activeIdxKey] >= 0) {
        e.preventDefault()
        const el = items[state[ctx.activeIdxKey]]
        selectKeyCandidate(ctx.selectCtx, el.dataset.key, el.dataset.summary || '')
        return
      }
    } else if (e.key === 'Escape') {
      state[ctx.activeIdxKey] = -1
      dropdown.style.display = 'none'
      dropdown.innerHTML = ''
      return
    } else {
      return
    }
    items.forEach((el, i) => el.classList.toggle('active', i === state[ctx.activeIdxKey]))
    if (state[ctx.activeIdxKey] >= 0) items[state[ctx.activeIdxKey]].scrollIntoView({ block: 'nearest' })
  })
}
