// 이슈 상세 모달의 댓글 영역 — 작성/편집/삭제 + tiptap 인스턴스 마운트 관리.
// detail.js의 closeIssueDetailModal에서 destroy*/isDirty*를 호출하므로 함께 export.
import { state } from '../state.js'
import {
  addIssueComment,
  updateIssueComment,
  deleteIssueComment,
  fetchAttachmentBlobUrl,
} from '../jira.js'
import { isEmptyAdf } from '../adfProsemirror.js'
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
      })
      newMount.dataset.tiptapMounted = '1'
      if (m.editingCommentSaving) editor.setEditable(false)
      m._editMount = newMount
    }
  } else if (m._editMount) {
    destroyInstanceOnMount(m._editMount)
    m._editMount = null
  }

  // 댓글 본문 안의 이미지(미디어 노드)도 본문과 동일하게 인증 프록시로 교체
  loadCommentImages()
}

// detail-comments 영역 안의 ADF media 이미지/썸네일을 인증된 Blob URL로 교체
async function loadCommentImages() {
  const m = state.issueDetailModal
  if (!m) return
  const root = document.querySelector('.detail-comments')
  if (!root) return
  const imgs = root.querySelectorAll('.detail-comment-body img[data-adf-media-url]')
  if (imgs.length === 0) return
  imgs.forEach(img => {
    const url = img.getAttribute('data-adf-media-url')
    img.removeAttribute('data-adf-media-url')
    if (!url) {
      img.classList.add('detail-img-error')
      img.alt = '(이미지 원본을 찾지 못함)'
      return
    }
    img.classList.add('detail-img-loading')
    fetchAttachmentBlobUrl(url).then(blobUrl => {
      if (!state.issueDetailModal || state.issueDetailModal.key !== m.key) return
      if (blobUrl) {
        img.src = blobUrl
        state.issueDetailModal.blobUrls.push(blobUrl)
      } else {
        img.classList.add('detail-img-error')
        img.alt = '(이미지 로드 실패)'
      }
      img.classList.remove('detail-img-loading')
    })
  })
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
  m.commentSubmitting = true
  m.commentError = null
  if (editor) editor.setEditable(false)
  render({ sections: ['modals'] })
  try {
    const created = await addIssueComment(m.key, adf)
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
  m.editingCommentSaving = true
  m.commentError = null
  if (editor) editor.setEditable(false)
  render({ sections: ['modals'] })
  try {
    const updated = await updateIssueComment(m.key, commentId, adf)
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
