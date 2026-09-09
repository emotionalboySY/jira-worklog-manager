// 오류 신고 / 개선 요청 모달 — 열기/닫기, 탭 전환, 작성·전송, 목록 펼침, 관리자 상태·답변 저장, 삭제
import { state } from '../state.js'
import { getSavedUser } from '../auth.js'
import { showToast } from '../ui.js'
import { render } from '../render.js'
import { fetchFeedback, submitFeedback, updateFeedback, deleteFeedback, getAppCommit } from '../feedback.js'
import { on } from './_dom.js'

const modalsOnly = { sections: ['modals'] }

function emptyDraft() {
  return { type: 'bug', title: '', body: '' }
}

// 신고와 함께 보내는 진단 정보 (서버가 허용 키만 저장)
function collectContext() {
  return {
    url: `${window.location.pathname}${window.location.search}`,
    view: state.currentMainTab,
    theme: state.theme,
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    appCommit: getAppCommit(),
    displayName: getSavedUser()?.displayName || '',
  }
}

export function openFeedback(tab = 'new') {
  if (state.showFeedback) return
  state.showFeedback = {
    tab,
    draft: emptyDraft(),
    submitting: false,
    error: null,
    items: null,        // 내 문의 목록 (null: 아직 미조회)
    allItems: null,     // 전체 목록 (관리자, null: 아직 미조회)
    loading: false,
    listError: null,
    isAdmin: false,
    expanded: new Set(),
    updating: new Set(),
    adminDrafts: {},    // 관리자 편집 중인 상태/답변 (재렌더 시 보존)
  }
  render(modalsOnly)
  // 열자마자 내 문의를 조회 — 응답의 isAdmin 으로 '전체 관리' 탭 노출 여부 결정
  loadList('mine')
}

export function closeFeedback() {
  if (!state.showFeedback) return
  if (state.showFeedback.submitting) return
  state.showFeedback = null
  render(modalsOnly)
}

async function loadList(scope) {
  const m = state.showFeedback
  if (!m) return
  m.loading = true
  m.listError = null
  render(modalsOnly)
  try {
    const data = await fetchFeedback(scope)
    const cur = state.showFeedback
    if (!cur) return
    cur.isAdmin = !!data.isAdmin
    if (scope === 'all') cur.allItems = data.items || []
    else cur.items = data.items || []
  } catch (e) {
    const cur = state.showFeedback
    if (!cur) return
    cur.listError = e?.message || '목록을 불러오지 못했습니다.'
  } finally {
    const cur = state.showFeedback
    if (cur) { cur.loading = false; render(modalsOnly) }
  }
}

function switchTab(tab) {
  const m = state.showFeedback
  if (!m || m.tab === tab) return
  captureAdminDrafts()
  m.tab = tab
  m.error = null
  render(modalsOnly)
  if (tab === 'mine' && m.items === null) loadList('mine')
  if (tab === 'all' && m.allItems === null) loadList('all')
}

// 재렌더 전에 관리자 편집 중인 select/textarea 값을 state에 보관
function captureAdminDrafts() {
  const m = state.showFeedback
  if (!m) return
  document.querySelectorAll('[data-fb-status]').forEach(sel => {
    const id = sel.dataset.fbStatus
    m.adminDrafts[id] = { ...(m.adminDrafts[id] || {}), status: sel.value }
  })
  document.querySelectorAll('[data-fb-reply]').forEach(ta => {
    const id = ta.dataset.fbReply
    m.adminDrafts[id] = { ...(m.adminDrafts[id] || {}), reply: ta.value }
  })
}

// 목록(내 문의/전체) 안의 항목을 갱신·제거
function replaceItem(m, updated) {
  for (const key of ['items', 'allItems']) {
    const list = m[key]
    if (!Array.isArray(list)) continue
    const i = list.findIndex(it => it.id === updated.id)
    if (i >= 0) list[i] = updated
  }
}
function removeItem(m, id) {
  for (const key of ['items', 'allItems']) {
    if (Array.isArray(m[key])) m[key] = m[key].filter(it => it.id !== id)
  }
}

async function submit() {
  const m = state.showFeedback
  if (!m || m.submitting) return
  const title = m.draft.title.trim()
  const body = m.draft.body.trim()
  if (!title) { m.error = '제목을 입력하세요.'; render(modalsOnly); return }
  if (!body) { m.error = '내용을 입력하세요.'; render(modalsOnly); return }
  m.submitting = true
  m.error = null
  render(modalsOnly)
  try {
    const data = await submitFeedback({ type: m.draft.type, title, body, context: collectContext() })
    const cur = state.showFeedback
    if (!cur) return
    cur.submitting = false
    cur.isAdmin = !!data.isAdmin
    cur.draft = emptyDraft()
    if (data.item) {
      cur.items = [data.item, ...(cur.items || [])]
      if (Array.isArray(cur.allItems)) cur.allItems = [data.item, ...cur.allItems]
      cur.expanded.add(data.item.id)
    }
    cur.tab = 'mine'
    render(modalsOnly)
    showToast('문의를 보냈습니다. 확인 후 답변을 남겨 드릴게요.', '✓')
  } catch (e) {
    const cur = state.showFeedback
    if (!cur) return
    cur.submitting = false
    cur.error = e?.message || '전송에 실패했습니다.'
    render(modalsOnly)
  }
}

async function saveAdmin(id) {
  const m = state.showFeedback
  if (!m || m.updating.has(id)) return
  const sel = document.querySelector(`[data-fb-status="${CSS.escape(id)}"]`)
  const ta = document.querySelector(`[data-fb-reply="${CSS.escape(id)}"]`)
  const patch = { status: sel ? sel.value : undefined, reply: ta ? ta.value : undefined }
  captureAdminDrafts()
  m.updating.add(id)
  render(modalsOnly)
  try {
    const data = await updateFeedback(id, patch)
    const cur = state.showFeedback
    if (!cur) return
    if (data.item) replaceItem(cur, data.item)
    delete cur.adminDrafts[id]
    showToast('저장했습니다.', '✓')
  } catch (e) {
    showToast(`저장 실패: ${e?.message || '알 수 없는 오류'}`, '⚠')
  } finally {
    const cur = state.showFeedback
    if (cur) { cur.updating.delete(id); render(modalsOnly) }
  }
}

async function remove(id) {
  const m = state.showFeedback
  if (!m || m.updating.has(id)) return
  const label = m.isAdmin ? '이 문의를 삭제할까요?' : '이 문의를 취소(삭제)할까요?'
  if (!window.confirm(label)) return
  captureAdminDrafts()
  m.updating.add(id)
  render(modalsOnly)
  try {
    await deleteFeedback(id)
    const cur = state.showFeedback
    if (!cur) return
    removeItem(cur, id)
    cur.expanded.delete(id)
    delete cur.adminDrafts[id]
    showToast('삭제했습니다.', '✓')
  } catch (e) {
    showToast(`삭제 실패: ${e?.message || '알 수 없는 오류'}`, '⚠')
  } finally {
    const cur = state.showFeedback
    if (cur) { cur.updating.delete(id); render(modalsOnly) }
  }
}

export function bindFeedbackEvents() {
  // 헤더 버튼
  const openBtn = document.getElementById('btn-feedback')
  if (openBtn) on(openBtn, 'click', () => openFeedback('new'))

  const m = state.showFeedback
  const overlay = document.getElementById('feedback-overlay')
  if (!m || !overlay) return

  const closeBtn = document.getElementById('feedback-close')
  if (closeBtn) on(closeBtn, 'click', closeFeedback)
  const cancelBtn = document.getElementById('feedback-cancel')
  if (cancelBtn) on(cancelBtn, 'click', closeFeedback)

  overlay.querySelectorAll('[data-fb-tab]').forEach(btn => {
    on(btn, 'click', () => switchTab(btn.dataset.fbTab))
  })

  // 새 문의 작성
  overlay.querySelectorAll('[data-fb-type]').forEach(btn => {
    on(btn, 'click', () => {
      const cur = state.showFeedback
      if (!cur || cur.submitting) return
      cur.draft.type = btn.dataset.fbType
      render(modalsOnly)
    })
  })
  const titleInput = document.getElementById('feedback-title')
  if (titleInput) {
    on(titleInput, 'input', (e) => { if (state.showFeedback) state.showFeedback.draft.title = e.target.value })
    // 모달을 처음 열었을 때만 제목에 포커스 (재렌더마다 포커스가 튀지 않도록)
    if (!m._focused) { titleInput.focus(); m._focused = true }
  }
  const bodyInput = document.getElementById('feedback-body')
  if (bodyInput) {
    on(bodyInput, 'input', (e) => { if (state.showFeedback) state.showFeedback.draft.body = e.target.value })
  }
  const submitBtn = document.getElementById('feedback-submit')
  if (submitBtn) on(submitBtn, 'click', submit)

  // 목록: 항목 펼침/접힘
  overlay.querySelectorAll('[data-fb-toggle]').forEach(btn => {
    on(btn, 'click', () => {
      const cur = state.showFeedback
      if (!cur) return
      const id = btn.dataset.fbToggle
      captureAdminDrafts()
      if (cur.expanded.has(id)) cur.expanded.delete(id)
      else cur.expanded.add(id)
      render(modalsOnly)
    })
  })

  // 관리자 저장 / 삭제(본인 취소 포함)
  overlay.querySelectorAll('[data-fb-save]').forEach(btn => {
    on(btn, 'click', () => saveAdmin(btn.dataset.fbSave))
  })
  overlay.querySelectorAll('[data-fb-delete]').forEach(btn => {
    on(btn, 'click', () => remove(btn.dataset.fbDelete))
  })
}
