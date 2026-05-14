// 이슈 상세 모달의 댓글 영역 — 작성/편집/삭제 + tiptap 인스턴스 마운트 관리.
// detail.js의 closeIssueDetailModal에서 destroy*/isDirty*를 호출하므로 함께 export.
import { state } from '../state.js'
import {
  addIssueComment,
  updateIssueComment,
  deleteIssueComment,
  uploadIssueAttachment,
  normalizeMediaForSave,
} from '../jira.js'
import { isEmptyAdf, hasUploadPlaceholders } from '../adfProsemirror.js'
import {
  createEditorInstance,
  destroyInstanceOnMount,
  getInstanceAdf,
  getEditorOnMount,
} from '../tiptap.js'
import { showToast } from '../ui.js'
import { formatJiraError } from '../utils.js'
import { render } from '../render.js'
import { on } from './_dom.js'

// 모달 내부 댓글용 tiptap 인스턴스 모두 정리
export function destroyCommentEditors() {
  const composeMount = document.getElementById('detail-comment-compose-editor')
  if (composeMount) destroyInstanceOnMount(composeMount)
  document.querySelectorAll('[id^="detail-comment-edit-editor-"]').forEach(mount => destroyInstanceOnMount(mount))
}

// 댓글 작성기에 의미 있는 입력이 있는지
export function isCommentComposeDirty() {
  const mount = document.getElementById('detail-comment-compose-editor')
  const editor = getEditorOnMount(mount)
  const adf = editor ? getInstanceAdf(editor) : state.issueDetailModal?.commentDraftAdf
  return !!adf && !isEmptyAdf(adf)
}

// 댓글 편집기 내용이 원본과 달라졌는지
export function isCommentEditDirty() {
  const m = state.issueDetailModal
  if (!m?.editingCommentId) return false
  const mount = document.getElementById(`detail-comment-edit-editor-${m.editingCommentId}`)
  const editor = getEditorOnMount(mount)
  if (!editor) return false
  const current = getInstanceAdf(editor)
  const original = (m.data?.comments || []).find(c => c.id === m.editingCommentId)?.bodyAdf || null
  // 단순 비교 (구조 동일하면 동일 JSON 문자열)
  return JSON.stringify(current) !== JSON.stringify(original)
}

// ========== 댓글 CRUD ==========
// 작성/편집 모두 본문과 동일한 tiptap 에디터 사용 → 멘션·이미지·표 등 풍부한 마크업 보존.
// 매 bindEvents 호출마다 (재)바인드. on() 헬퍼가 element별 1회 바인드라 modals 재렌더로
// element가 새로 생기면 자동 재바인드 + 새 element에 새 에디터 마운트.
export function bindCommentEvents() {
  const m = state.issueDetailModal
  if (!m || !m.data) return

  // 작성기 펼치기 트리거 (collapsed placeholder)
  const composeOpen = document.getElementById('detail-comment-compose-open')
  if (composeOpen) on(composeOpen, 'click', openCommentCompose)

  // 작성 취소 / 작성 버튼
  const composeCancel = document.getElementById('detail-comment-compose-cancel')
  if (composeCancel) on(composeCancel, 'click', cancelCommentCompose)
  const submitBtn = document.getElementById('detail-comment-submit')
  if (submitBtn) on(submitBtn, 'click', submitNewComment)

  // 각 댓글의 수정/삭제/취소/저장
  document.querySelectorAll('[data-action="edit-comment"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      startEditComment(btn.dataset.commentId)
    })
  })
  document.querySelectorAll('[data-action="cancel-edit-comment"]').forEach(btn => {
    on(btn, 'click', (e) => { e.stopPropagation(); cancelEditComment() })
  })
  document.querySelectorAll('[data-action="save-edit-comment"]').forEach(btn => {
    on(btn, 'click', (e) => { e.stopPropagation(); saveEditComment(btn.dataset.commentId) })
  })
  document.querySelectorAll('[data-action="delete-comment"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      const cur = state.issueDetailModal
      if (!cur) return
      cur.deletingCommentId = btn.dataset.commentId
      cur.commentError = null
      render({ sections: ['modals'] })
    })
  })
  document.querySelectorAll('[data-action="cancel-delete-comment"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      const cur = state.issueDetailModal
      if (!cur || cur.commentSubmitting) return
      cur.deletingCommentId = null
      render({ sections: ['modals'] })
    })
  })
  document.querySelectorAll('[data-action="confirm-delete-comment"]').forEach(btn => {
    on(btn, 'click', (e) => { e.stopPropagation(); confirmDeleteComment(btn.dataset.commentId) })
  })
}

// 매 bindEvents 후 호출: 작성/편집 모드의 mount element가 있으면 tiptap 인스턴스 마운트.
// modals 재렌더로 element가 새로 생기면 이전 인스턴스를 destroy하고 새 element에 다시 마운트.
// onUpdate가 ADF를 m.commentDraftAdf / m.editingCommentDraftAdf에 보존하므로 입력 내용은 유지된다.
export function ensureCommentEditors() {
  const m = state.issueDetailModal
  if (!m || !m.data) return

  // ----- 작성기 -----
  if (m.commentComposeOpen) {
    const newMount = document.getElementById('detail-comment-compose-editor')
    if (newMount && newMount !== m._composeMount) {
      // 이전 인스턴스(detached element 포함) 정리
      if (m._composeMount) destroyInstanceOnMount(m._composeMount)
      const editor = createEditorInstance(newMount, m.commentDraftAdf, {
        onUpdate: (adf) => {
          const cur = state.issueDetailModal
          if (cur) cur.commentDraftAdf = adf
        },
        attachments: m.data?.attachments || [],
        onImagePaste: makeCommentImagePaste(m.key),
        onUploadError: (err) => showToast(`이미지 업로드 실패: ${err?.message || '알 수 없는 오류'}`, '⚠'),
      })
      newMount.dataset.tiptapMounted = '1'
      if (m.commentSubmitting) editor.setEditable(false)
      m._composeMount = newMount
    }
  } else if (m._composeMount) {
    destroyInstanceOnMount(m._composeMount)
    m._composeMount = null
  }

  // ----- 편집기 (한 번에 하나만 활성) -----
  if (m.editingCommentId) {
    const id = m.editingCommentId
    const newMount = document.getElementById(`detail-comment-edit-editor-${id}`)
    if (newMount && newMount !== m._editMount) {
      if (m._editMount) destroyInstanceOnMount(m._editMount)
      const editor = createEditorInstance(newMount, m.editingCommentDraftAdf, {
        onUpdate: (adf) => {
          const cur = state.issueDetailModal
          if (cur) cur.editingCommentDraftAdf = adf
        },
        attachments: m.data?.attachments || [],
        onImagePaste: makeCommentImagePaste(m.key),
        onUploadError: (err) => showToast(`이미지 업로드 실패: ${err?.message || '알 수 없는 오류'}`, '⚠'),
      })
      newMount.dataset.tiptapMounted = '1'
      if (m.editingCommentSaving) editor.setEditable(false)
      m._editMount = newMount
    }
  } else if (m._editMount) {
    destroyInstanceOnMount(m._editMount)
    m._editMount = null
  }
  // 댓글 본문 이미지는 detail.js의 loadIssueDetailImages가 bindDetailModalEvents에서 통합 처리
}

// 댓글 에디터의 이미지 paste/drop 후크. 업로드 결과를 모달 상태의 첨부 목록에도 즉시 머지.
function makeCommentImagePaste(issueKey) {
  return async (file) => {
    const result = await uploadIssueAttachment(issueKey, file)
    const cur = state.issueDetailModal
    if (cur && cur.key === issueKey && cur.data) {
      if (!Array.isArray(cur.data.attachments)) cur.data.attachments = []
      cur.data.attachments.push({
        id: result.id,
        filename: result.filename,
        mimeType: result.mimeType,
        size: result.size,
        contentUrl: result.contentUrl,
        thumbnailUrl: result.thumbnailUrl,
      })
    }
    return result
  }
}

export function openCommentCompose() {
  const m = state.issueDetailModal
  if (!m) return
  m.commentComposeOpen = true
  m.commentDraftAdf = m.commentDraftAdf || null
  m.commentError = null
  render({ sections: ['modals'] })
}

export function cancelCommentCompose() {
  const m = state.issueDetailModal
  if (!m || m.commentSubmitting) return
  // mount destroy 후 영역 닫기
  const mount = document.getElementById('detail-comment-compose-editor')
  if (mount) destroyInstanceOnMount(mount)
  m.commentComposeOpen = false
  m.commentDraftAdf = null
  m.commentError = null
  render({ sections: ['modals'] })
}

async function submitNewComment() {
  const m = state.issueDetailModal
  if (!m || m.commentSubmitting) return
  const mount = document.getElementById('detail-comment-compose-editor')
  const editor = getEditorOnMount(mount)
  const adf = editor ? getInstanceAdf(editor) : m.commentDraftAdf
  if (!adf || isEmptyAdf(adf)) {
    m.commentError = '내용을 입력하세요.'
    render({ sections: ['modals'] })
    return
  }
  if (hasUploadPlaceholders(adf)) {
    showToast('이미지 업로드가 끝나면 다시 시도해 주세요.', '⚠')
    return
  }
  m.commentSubmitting = true
  m.commentError = null
  if (editor) editor.setEditable(false)
  render({ sections: ['modals'] })
  try {
    const adfToSave = normalizeMediaForSave(adf, m.data?.attachments || [])
    const created = await addIssueComment(m.key, adfToSave)
    const cur = state.issueDetailModal
    if (!cur || cur.key !== m.key) return
    if (cur.data) {
      cur.data.comments = [...(cur.data.comments || []), created]
    }
    // 작성기 닫고 비우기
    const liveMount = document.getElementById('detail-comment-compose-editor')
    if (liveMount) destroyInstanceOnMount(liveMount)
    cur.commentComposeOpen = false
    cur.commentDraftAdf = null
    showToast('댓글을 작성했습니다.', '✓')
  } catch (err) {
    console.error('댓글 작성 실패:', err)
    const cur = state.issueDetailModal
    if (cur) cur.commentError = `작성 실패: ${formatJiraError(err)}`
    showToast(`댓글 작성 실패: ${formatJiraError(err)}`, '⚠')
  } finally {
    const cur = state.issueDetailModal
    if (cur) cur.commentSubmitting = false
    render({ sections: ['modals'] })
  }
}

function startEditComment(commentId) {
  const m = state.issueDetailModal
  if (!m || !m.data) return
  const c = (m.data.comments || []).find(x => x.id === commentId)
  if (!c) return
  m.editingCommentId = commentId
  m.editingCommentDraftAdf = c.bodyAdf || null
  m.editingCommentSaving = false
  m.commentError = null
  m.deletingCommentId = null
  render({ sections: ['modals'] })
}

export function cancelEditComment() {
  const m = state.issueDetailModal
  if (!m || m.editingCommentSaving) return
  if (m.editingCommentId) {
    const mount = document.getElementById(`detail-comment-edit-editor-${m.editingCommentId}`)
    if (mount) destroyInstanceOnMount(mount)
  }
  m.editingCommentId = null
  m.editingCommentDraftAdf = null
  m.commentError = null
  render({ sections: ['modals'] })
}

async function saveEditComment(commentId) {
  const m = state.issueDetailModal
  if (!m || m.editingCommentSaving) return
  const mount = document.getElementById(`detail-comment-edit-editor-${commentId}`)
  const editor = getEditorOnMount(mount)
  const adf = editor ? getInstanceAdf(editor) : m.editingCommentDraftAdf
  if (!adf || isEmptyAdf(adf)) {
    m.commentError = '내용을 입력하세요.'
    render({ sections: ['modals'] })
    return
  }
  if (hasUploadPlaceholders(adf)) {
    showToast('이미지 업로드가 끝나면 다시 시도해 주세요.', '⚠')
    return
  }
  m.editingCommentSaving = true
  m.commentError = null
  if (editor) editor.setEditable(false)
  render({ sections: ['modals'] })
  try {
    const adfToSave = normalizeMediaForSave(adf, m.data?.attachments || [])
    const updated = await updateIssueComment(m.key, commentId, adfToSave)
    const cur = state.issueDetailModal
    if (!cur || cur.key !== m.key) return
    if (cur.data) {
      cur.data.comments = (cur.data.comments || []).map(c =>
        c.id === commentId ? updated : c
      )
    }
    const liveMount = document.getElementById(`detail-comment-edit-editor-${commentId}`)
    if (liveMount) destroyInstanceOnMount(liveMount)
    cur.editingCommentId = null
    cur.editingCommentDraftAdf = null
    showToast('댓글을 수정했습니다.', '✓')
  } catch (err) {
    console.error('댓글 수정 실패:', err)
    const cur = state.issueDetailModal
    if (cur) cur.commentError = `수정 실패: ${formatJiraError(err)}`
    showToast(`댓글 수정 실패: ${formatJiraError(err)}`, '⚠')
  } finally {
    const cur = state.issueDetailModal
    if (cur) cur.editingCommentSaving = false
    render({ sections: ['modals'] })
  }
}

async function confirmDeleteComment(commentId) {
  const m = state.issueDetailModal
  if (!m || m.commentSubmitting) return
  m.commentSubmitting = true
  render({ sections: ['modals'] })
  try {
    await deleteIssueComment(m.key, commentId)
    const cur = state.issueDetailModal
    if (!cur || cur.key !== m.key) return
    if (cur.data) {
      cur.data.comments = (cur.data.comments || []).filter(c => c.id !== commentId)
    }
    cur.deletingCommentId = null
    showToast('댓글을 삭제했습니다.', '✓')
  } catch (err) {
    console.error('댓글 삭제 실패:', err)
    showToast(`댓글 삭제 실패: ${formatJiraError(err)}`, '⚠')
  } finally {
    const cur = state.issueDetailModal
    if (cur) cur.commentSubmitting = false
    render({ sections: ['modals'] })
  }
}
