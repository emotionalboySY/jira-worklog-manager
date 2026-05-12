// 이슈 상세 모달 — 열기/닫기, 설명(ADF) 본문 편집, 요약 인라인 편집, 첨부/이미지 로드.
// 댓글 영역은 comments.js로 분리. closeIssueDetailModal이 comments의 dirty 검사/정리 호출.
import { state } from '../state.js'
import {
  fetchIssueDetail,
  fetchAttachmentBlobUrl,
  updateIssueDescription,
  updateIssueSummary,
  uploadIssueAttachment,
  fetchMyself,
  fetchIssueLinkTypes,
  fetchIssuesByKeys,
  createIssueLink,
  deleteIssueLink,
  searchIssuesByKey,
} from '../jira.js'
import { getProjectKeysOrFallback, formatJiraError } from '../utils.js'
import { renderAddLinkSuggestionsHtml } from '../views/modals.js'
import { detectLossyFeatures, isEmptyAdf, hasUploadPlaceholders, stripUploadPlaceholders } from '../adfProsemirror.js'
import {
  createEditor,
  destroyEditor,
  getCurrentAdf,
  setEditable,
} from '../tiptap.js'
import {
  updateIssueSummaryEverywhere,
} from '../storage.js'
import { showToast } from '../ui.js'
import { findLoadedIssue } from '../views/modals.js'
import { render } from '../render.js'
import {
  destroyCommentEditors,
  isCommentComposeDirty,
  isCommentEditDirty,
  cancelCommentCompose,
  cancelEditComment,
} from './comments.js'
import { on } from './_dom.js'

// 이슈 상세 모달 닫기 + Blob URL 해제 + 에디터 파괴
export function closeIssueDetailModal() {
  const m = state.issueDetailModal
  // 편집 중이면 에디터 내용으로 dirty 판정 (본문 + 댓글 작성기/편집기)
  if (m?.editing && isEditorDirty()) {
    if (!window.confirm('편집 중인 내용이 있습니다. 닫으시겠습니까?')) return
  } else if (m?.commentComposeOpen && isCommentComposeDirty()) {
    if (!window.confirm('작성 중인 댓글이 있습니다. 닫으시겠습니까?')) return
  } else if (m?.editingCommentId && isCommentEditDirty()) {
    if (!window.confirm('수정 중인 댓글이 있습니다. 닫으시겠습니까?')) return
  }
  destroyEditor()
  destroyCommentEditors()
  if (m?.blobUrls) {
    for (const url of m.blobUrls) {
      try { URL.revokeObjectURL(url) } catch {}
    }
  }
  state.issueDetailModal = null
  render({ sections: ['modals'] })
}

// 편집 진입: editAdf에 현재 본문 복사 후 render → ensureTiptap이 마운트
export function enterIssueDetailEditMode() {
  const m = state.issueDetailModal
  if (!m || m.editing || m.loading) return
  const adf = m.data?.descriptionAdf
  m.editing = true
  m.editAdf = adf ? JSON.parse(JSON.stringify(adf)) : null
  m.lossyFeatures = adf ? detectLossyFeatures(adf) : []
  m.saveError = null
  render({ sections: ['modals'] })
}

export function cancelIssueDetailEdit() {
  const m = state.issueDetailModal
  if (!m || m.saving) return
  if (isEditorDirty()) {
    if (!window.confirm('변경사항이 저장되지 않습니다. 취소하시겠습니까?')) return
  }
  destroyEditor()
  m.editing = false
  m.editAdf = null
  m.saveError = null
  m.lossyFeatures = null
  render({ sections: ['modals'] })
}

// 저장 중에 푸터의 저장/취소 버튼만 직접 DOM 갱신해 스피너/잠금 표시.
// (전체 재렌더 시 에디터의 DOM이 교체되어 사용자 입력 상태가 사라지는 것을 피하기 위함)
function setDescSavingButtons(saving) {
  const saveBtn = document.getElementById('issue-detail-edit-save')
  const cancelBtn = document.getElementById('issue-detail-edit-cancel')
  if (saveBtn) {
    saveBtn.disabled = saving
    saveBtn.innerHTML = saving ? '<span class="btn-spinner"></span> 저장 중…' : '저장'
  }
  if (cancelBtn) cancelBtn.disabled = saving
  // 이전 저장 시도의 에러 메시지가 남아 있으면 새 시도 시작 시 제거
  if (saving) {
    const errEl = document.querySelector('#issue-detail-overlay .detail-edit-error')
    if (errEl) errEl.remove()
  }
}

export async function saveIssueDetailEdit() {
  const m = state.issueDetailModal
  if (!m || !m.editing || m.saving) return
  const adfDoc = getCurrentAdf()
  if (!adfDoc) return
  // 업로드 중인 이미지가 있으면 저장 차단 — 자리표시자는 Jira ADF에 들어가면 안 됨
  if (hasUploadPlaceholders(adfDoc)) {
    showToast('이미지 업로드가 끝나면 다시 저장해 주세요.', '⚠')
    return
  }
  const empty = isEmptyAdf(adfDoc)

  m.saving = true
  m.saveError = null
  m.editAdf = adfDoc   // 실패 시 / 재렌더 시 에디터 복구용

  // 에디터는 그대로 두고 입력만 잠그고, 푸터 버튼만 스피너/disabled 처리
  setEditable(false)
  setDescSavingButtons(true)

  try {
    await updateIssueDescription(m.key, empty ? null : adfDoc)
    const fresh = await fetchIssueDetail(m.key)
    if (!state.issueDetailModal || state.issueDetailModal.key !== m.key) return
    destroyEditor()
    state.issueDetailModal.data = fresh || {}
    state.issueDetailModal.editing = false
    state.issueDetailModal.editAdf = null
    state.issueDetailModal.saving = false
    state.issueDetailModal.saveError = null
    state.issueDetailModal.lossyFeatures = null
    render({ sections: ['modals'] })
    loadIssueDetailImages()
    showToast('이슈 설명이 저장되었습니다.', '✓')
  } catch (err) {
    if (!state.issueDetailModal || state.issueDetailModal.key !== m.key) return
    state.issueDetailModal.saving = false
    state.issueDetailModal.saveError = err?.message || '알 수 없는 오류'
    // 잠금 해제 후 에러 메시지 표시 (에디터는 그대로, 부분 재렌더로 메시지만 갱신)
    setEditable(true)
    setDescSavingButtons(false)
    // 저장 에러 메시지를 에디터 아래에 삽입 (전체 재렌더 회피)
    const mount = document.getElementById('issue-detail-edit-editor')
    if (mount && state.issueDetailModal.saveError) {
      const div = document.createElement('div')
      div.className = 'detail-edit-error'
      div.textContent = `저장 실패: ${state.issueDetailModal.saveError}`
      mount.parentNode?.insertBefore(div, mount.nextSibling)
    }
  }
}

// ----- 요약(summary) 인라인 편집 -----
export function enterSummaryEdit() {
  const m = state.issueDetailModal
  if (!m || m.summaryEditing || m.loading) return
  const current = m.data?.summary || findLoadedIssue(m.key)?.summary || ''
  m.summaryEditing = true
  m.summaryDraft = current
  m.summarySaving = false
  m.summaryError = null
  render({ sections: ['modals'] })
  // 렌더 후 input에 포커스 + 전체 선택
  setTimeout(() => {
    const input = document.getElementById('issue-detail-summary-input')
    if (input) { input.focus(); input.select() }
  }, 0)
}

export function cancelSummaryEdit() {
  const m = state.issueDetailModal
  if (!m || !m.summaryEditing || m.summarySaving) return
  m.summaryEditing = false
  m.summaryDraft = null
  m.summaryError = null
  render({ sections: ['modals'] })
}

// 저장 중 input/버튼 직접 갱신 (전체 재렌더 시 input의 IME 조합/선택이 깨지는 것 방지)
function setSummarySavingUI(saving) {
  const input = document.getElementById('issue-detail-summary-input')
  const saveBtn = document.getElementById('issue-detail-summary-save')
  const cancelBtn = document.getElementById('issue-detail-summary-cancel')
  if (input) input.disabled = saving
  if (saveBtn) {
    saveBtn.disabled = saving
    saveBtn.innerHTML = saving ? '<span class="btn-spinner"></span> 저장 중…' : '저장'
  }
  if (cancelBtn) cancelBtn.disabled = saving
}

export async function saveSummaryEdit() {
  const m = state.issueDetailModal
  if (!m || !m.summaryEditing || m.summarySaving) return
  const input = document.getElementById('issue-detail-summary-input')
  const newSummary = (input?.value ?? m.summaryDraft ?? '').trim()
  if (!newSummary) {
    m.summaryError = '요약은 비워둘 수 없습니다.'
    render({ sections: ['modals'] })
    return
  }
  const original = m.data?.summary || ''
  if (newSummary === original) {
    // 변경 없음 — 그냥 편집 모드 종료
    m.summaryEditing = false
    m.summaryDraft = null
    m.summaryError = null
    render({ sections: ['modals'] })
    return
  }

  m.summarySaving = true
  m.summaryError = null
  m.summaryDraft = newSummary
  setSummarySavingUI(true)

  try {
    await updateIssueSummary(m.key, newSummary)
    if (!state.issueDetailModal || state.issueDetailModal.key !== m.key) return
    // 모달 데이터 + 이슈 목록 + 세션/즐겨찾기 저장소 모두 동기화
    if (state.issueDetailModal.data) state.issueDetailModal.data.summary = newSummary
    for (const issue of state.realIssues) {
      if (issue.key === m.key) { issue.summary = newSummary; break }
    }
    updateIssueSummaryEverywhere(m.key, newSummary)
    state.issueDetailModal.summaryEditing = false
    state.issueDetailModal.summaryDraft = null
    state.issueDetailModal.summarySaving = false
    state.issueDetailModal.summaryError = null
    render({ sections: ['modals', 'content', 'sessions', 'favorites'] })
    showToast('요약이 저장되었습니다.', '✓')
  } catch (err) {
    if (!state.issueDetailModal || state.issueDetailModal.key !== m.key) return
    state.issueDetailModal.summarySaving = false
    state.issueDetailModal.summaryError = err?.message || '알 수 없는 오류'
    setSummarySavingUI(false)
    // 에러 메시지를 직접 DOM에 삽입 (input/포커스 보존)
    const editBox = document.querySelector('.detail-summary-edit')
    if (editBox) {
      let errEl = editBox.querySelector('.detail-summary-error')
      if (!errEl) {
        errEl = document.createElement('div')
        errEl.className = 'detail-summary-error'
        editBox.appendChild(errEl)
      }
      errEl.textContent = `저장 실패: ${state.issueDetailModal.summaryError}`
    }
  }
}

// 에디터의 현재 ADF와 m.data.descriptionAdf를 비교해 변경 여부 판단
export function isEditorDirty() {
  const m = state.issueDetailModal
  if (!m) return false
  const current = getCurrentAdf()
  const original = m.data?.descriptionAdf || null
  return JSON.stringify(current) !== JSON.stringify(original)
}

// 매 bindEvents 호출 후 실행: 편집 모드면 tiptap을 마운트
// 저장 중에도 외부 사정으로 재렌더가 일어날 수 있으므로 다시 마운트하되,
// 입력은 잠근 상태로 유지한다.
export function ensureIssueDetailEditor() {
  const m = state.issueDetailModal
  if (!m?.editing) return
  const mount = document.getElementById('issue-detail-edit-editor')
  if (!mount || mount.dataset.tiptapMounted === '1') return
  createEditor(mount, m.editAdf, {
    attachments: m.data?.attachments || [],
    // 모달 부분 재렌더로 mount가 다시 만들어질 때 입력 내용/이미지가 사라지지 않도록
    // editAdf를 지속 동기화 → 다음 마운트가 이 값을 그대로 복원
    onUpdate: (adf) => {
      const cur = state.issueDetailModal
      if (cur && cur.editing) cur.editAdf = adf
    },
    onImagePaste: async (file) => {
      // 업로드 → 모달 상태의 attachments에 즉시 반영 (이후 같은 이미지를 같은 id로 매칭하기 위함)
      const result = await uploadIssueAttachment(m.key, file)
      const cur = state.issueDetailModal
      if (cur && cur.key === m.key && cur.data) {
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
    },
    onUploadError: (err) => {
      showToast(`이미지 업로드 실패: ${err?.message || '알 수 없는 오류'}`, '⚠')
    },
  })
  if (m.saving) setEditable(false)
  mount.dataset.tiptapMounted = '1'
}

// 이슈 상세 모달 열기 + 상세 데이터 비동기 로드
export async function openIssueDetailModal(issueKey) {
  state.issueDetailModal = {
    key: issueKey, loading: true, data: null, error: null, blobUrls: [],
    linkTypes: null, addLink: null, linkRemoving: new Set(),
  }
  render({ sections: ['modals'] })

  // 본인 정보(댓글 권한 비교용)는 백그라운드로 미리 받아둠 — 결과가 늦게 와도 댓글이 다시 그려지면 반영됨
  fetchMyself().then(me => {
    if (me && state.issueDetailModal && state.issueDetailModal.key === issueKey) {
      render({ sections: ['modals'] })
    }
  })

  // 링크 타입 미리 로드 (사이트 전체 캐시)
  fetchIssueLinkTypes().then(types => {
    if (!state.issueDetailModal || state.issueDetailModal.key !== issueKey) return
    state.issueDetailModal.linkTypes = types
    render({ sections: ['modals'] })
  }).catch(err => console.warn('링크 타입 조회 실패:', err))

  try {
    const detail = await fetchIssueDetail(issueKey)
    if (!state.issueDetailModal || state.issueDetailModal.key !== issueKey) return
    state.issueDetailModal.data = detail || {}
    state.issueDetailModal.loading = false
    render({ sections: ['modals'] })
    // DOM에 붙은 후 이미지/썸네일을 인증 프록시로 교체
    loadIssueDetailImages()
    // 연결 항목의 assignee는 issuelinks 응답에 안 와서 batch로 보강
    loadLinkedIssueAssignees()
  } catch (err) {
    if (!state.issueDetailModal || state.issueDetailModal.key !== issueKey) return
    state.issueDetailModal.loading = false
    state.issueDetailModal.error = err?.message || '알 수 없는 오류'
    render({ sections: ['modals'] })
  }
}

// 연결 항목의 assignee를 batch로 조회해 머지 (백그라운드, 실패해도 무시)
async function loadLinkedIssueAssignees() {
  const m = state.issueDetailModal
  if (!m?.data?.links?.length) return
  const keys = m.data.links.map(l => l.issue?.key).filter(Boolean)
  if (keys.length === 0) return
  try {
    const issues = await fetchIssuesByKeys(keys, 'assignee')
    const cur = state.issueDetailModal
    if (!cur || cur.key !== m.key) return
    const byKey = new Map(issues.map(i => [i.key, i]))
    for (const l of cur.data.links) {
      const fetched = byKey.get(l.issue?.key)
      const a = fetched?.fields?.assignee
      if (a && a.accountId) {
        const urls = a.avatarUrls || {}
        l.issue.assignee = {
          accountId: a.accountId,
          displayName: a.displayName || '',
          avatarUrl: urls['32x32'] || urls['48x48'] || urls['24x24'] || urls['16x16'] || '',
        }
      } else if (fetched) {
        l.issue.assignee = null
      }
    }
    render({ sections: ['modals'] })
  } catch (err) {
    console.warn('연결 항목 담당자 조회 실패:', err)
  }
}

// 연결 항목 추가: 카테고리(value) + 검색 결과 키 → createIssueLink 호출
async function addIssueLinkTo(targetKey) {
  const m = state.issueDetailModal
  if (!m || !targetKey) return
  const linkTypes = m.linkTypes || []
  const value = m.addLink?.value || ''
  const [typeId, direction] = value.split(':')
  const lt = linkTypes.find(t => String(t.id) === String(typeId))
  if (!lt) {
    showToast('연결 유형을 선택하세요.', '⚠')
    return
  }
  const inwardKey = direction === 'outward' ? m.key : targetKey
  const outwardKey = direction === 'outward' ? targetKey : m.key
  try {
    await createIssueLink(lt.name, inwardKey, outwardKey)
    // 검색 input 초기화
    if (m.addLink) {
      m.addLink.query = ''
      m.addLink.suggestions = []
    }
    // 상세 재로드 (링크 + assignee 모두 새로 로드)
    await reloadIssueDetailLinks()
    showToast('연결을 추가했습니다.', '✓')
  } catch (err) {
    console.error('연결 추가 실패:', err)
    showToast(`연결 추가 실패: ${formatJiraError(err)}`, '⚠')
  }
}

async function removeIssueLink(linkId) {
  const m = state.issueDetailModal
  if (!m || !linkId) return
  if (!m.linkRemoving) m.linkRemoving = new Set()
  m.linkRemoving.add(linkId)
  render({ sections: ['modals'] })
  try {
    await deleteIssueLink(linkId)
    await reloadIssueDetailLinks()
    showToast('연결을 해제했습니다.', '✓')
  } catch (err) {
    console.error('연결 해제 실패:', err)
    showToast(`연결 해제 실패: ${formatJiraError(err)}`, '⚠')
  } finally {
    if (state.issueDetailModal?.linkRemoving) state.issueDetailModal.linkRemoving.delete(linkId)
    render({ sections: ['modals'] })
  }
}

// 링크 변경(추가/해제) 후 상세 재로드 (전체 fetchIssueDetail 호출)
async function reloadIssueDetailLinks() {
  const m = state.issueDetailModal
  if (!m) return
  const issueKey = m.key
  try {
    const detail = await fetchIssueDetail(issueKey)
    if (!state.issueDetailModal || state.issueDetailModal.key !== issueKey) return
    state.issueDetailModal.data = detail || {}
    render({ sections: ['modals'] })
    loadLinkedIssueAssignees()
  } catch (err) {
    console.warn('상세 재로드 실패:', err)
  }
}

// 검색: query → suggestions. createIssue 모달과 같은 패턴 (debounce 250ms).
let _addLinkSearchController = null
let _addLinkSearchTimer = null
function scheduleAddLinkSearch() {
  const m = state.issueDetailModal
  if (!m || !m.addLink) return
  const q = (m.addLink.query || '').trim()

  if (_addLinkSearchController) { try { _addLinkSearchController.abort() } catch {} }
  if (_addLinkSearchTimer) clearTimeout(_addLinkSearchTimer)

  if (!q) {
    m.addLink.suggestions = []
    m.addLink.searching = false
    refreshAddLinkSuggestions()
    return
  }

  m.addLink.searching = true
  refreshAddLinkSuggestions()

  _addLinkSearchTimer = setTimeout(async () => {
    const cur = state.issueDetailModal
    if (!cur || !cur.addLink || cur.addLink.query !== q) return
    const ctrl = new AbortController()
    _addLinkSearchController = ctrl
    try {
      const results = await searchIssuesByKey(q, getProjectKeysOrFallback(), { signal: ctrl.signal })
      const cur2 = state.issueDetailModal
      if (!cur2 || !cur2.addLink || cur2.addLink.query !== q) return
      // 본인 이슈는 후보에서 제외
      cur2.addLink.suggestions = results.filter(r => r.key !== cur2.key)
      cur2.addLink.searching = false
      refreshAddLinkSuggestions()
    } catch (err) {
      if (err?.name === 'AbortError') return
      console.warn('연결 검색 실패:', err)
      const cur2 = state.issueDetailModal
      if (cur2?.addLink) {
        cur2.addLink.suggestions = []
        cur2.addLink.searching = false
        refreshAddLinkSuggestions()
      }
    }
  }, 250)
}

// 검색 결과 영역만 부분 갱신 — input의 IME 조합 / 커서 위치 보존
function refreshAddLinkSuggestions() {
  const el = document.getElementById('detail-link-add-suggestions')
  if (!el) return
  el.innerHTML = renderAddLinkSuggestionsHtml(state.issueDetailModal?.addLink || {})
}

// 본문 설명의 <img>와 첨부 썸네일을 인증 프록시로 받아 Blob URL로 교체
export async function loadIssueDetailImages() {
  const m = state.issueDetailModal
  if (!m) return
  const modal = document.getElementById('issue-detail-overlay')
  if (!modal) return

  // 1) ADF media 노드: data-adf-media-url 속성에 담긴 Jira 첨부 URL을 Blob URL로 교체
  const mediaImgs = modal.querySelectorAll('.detail-description img[data-adf-media-url]')
  const tasks = []
  mediaImgs.forEach(img => {
    const url = img.getAttribute('data-adf-media-url')
    img.removeAttribute('data-adf-media-url')
    if (!url) {
      img.classList.add('detail-img-error')
      img.alt = '(이미지 원본을 찾지 못함)'
      return
    }
    img.classList.add('detail-img-loading')
    tasks.push(
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
    )
  })

  // 2) 첨부 썸네일
  const thumbs = modal.querySelectorAll('.detail-attachment-thumb[data-thumb-url]')
  thumbs.forEach(thumb => {
    const url = thumb.getAttribute('data-thumb-url')
    if (!url) return
    thumb.removeAttribute('data-thumb-url')
    thumb.classList.add('detail-img-loading')
    tasks.push(
      fetchAttachmentBlobUrl(url).then(blobUrl => {
        if (!state.issueDetailModal || state.issueDetailModal.key !== m.key) return
        if (blobUrl) {
          thumb.style.backgroundImage = `url("${blobUrl}")`
          state.issueDetailModal.blobUrls.push(blobUrl)
        } else {
          thumb.classList.add('detail-img-error')
        }
        thumb.classList.remove('detail-img-loading')
      })
    )
  })

  await Promise.all(tasks)
}

// closeIssueDetailModal의 ESC 흐름에서 댓글 작성기/편집기 취소도 같이 처리되도록 재export
export { cancelCommentCompose, cancelEditComment }

// 상세 모달의 버튼/클릭 바인딩 (modals 섹션 재렌더 시마다 호출)
export function bindDetailModalEvents() {
  // 닫기 버튼들
  const detailCloseBtn = document.getElementById('issue-detail-close')
  if (detailCloseBtn) on(detailCloseBtn, 'click', closeIssueDetailModal)
  const detailCloseFooterBtn = document.getElementById('issue-detail-close-footer')
  if (detailCloseFooterBtn) on(detailCloseFooterBtn, 'click', closeIssueDetailModal)

  // 첨부 클릭 → 새 탭으로 Jira 다운로드 URL 열기
  document.querySelectorAll('#issue-detail-overlay .detail-attachment').forEach(el => {
    on(el, 'click', async (e) => {
      e.preventDefault()
      const url = el.dataset.attachmentUrl
      if (!url) return
      const blobUrl = await fetchAttachmentBlobUrl(url)
      if (blobUrl) {
        window.open(blobUrl, '_blank', 'noopener,noreferrer')
        // 메모리 누수 방지를 위해 일정 시간 후 revoke
        setTimeout(() => { try { URL.revokeObjectURL(blobUrl) } catch {} }, 60000)
      } else {
        showToast('첨부파일을 불러오지 못했습니다.', '⚠')
      }
    })
  })

  // 설명 영역 클릭 → 편집 모드 진입
  const detailDescEl = document.getElementById('issue-detail-description')
  if (detailDescEl) {
    on(detailDescEl, 'click', (e) => {
      // 설명 내부 링크/이미지 클릭은 기본 동작 유지
      if (e.target.closest('a, img')) return
      enterIssueDetailEditMode()
    })
  }

  // 요약 영역 클릭 → 인라인 편집 모드 진입
  const detailSummaryEl = document.getElementById('issue-detail-summary')
  if (detailSummaryEl) on(detailSummaryEl, 'click', enterSummaryEdit)

  // 요약 편집: Enter=저장 / Esc=취소
  const summaryInput = document.getElementById('issue-detail-summary-input')
  if (summaryInput) {
    on(summaryInput, 'keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        saveSummaryEdit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()  // 전역 ESC 리스너의 모달 닫기 동작 차단
        cancelSummaryEdit()
      }
    })
  }
  const summaryCancelBtn = document.getElementById('issue-detail-summary-cancel')
  if (summaryCancelBtn) on(summaryCancelBtn, 'click', cancelSummaryEdit)
  const summarySaveBtn = document.getElementById('issue-detail-summary-save')
  if (summarySaveBtn) on(summarySaveBtn, 'click', saveSummaryEdit)

  // 본문 편집 취소/저장 버튼
  const detailEditCancelBtn = document.getElementById('issue-detail-edit-cancel')
  if (detailEditCancelBtn) on(detailEditCancelBtn, 'click', cancelIssueDetailEdit)
  const detailEditSaveBtn = document.getElementById('issue-detail-edit-save')
  if (detailEditSaveBtn) on(detailEditSaveBtn, 'click', saveIssueDetailEdit)

  // 본문 편집 tiptap 마운트 (중복 마운트 방지)
  ensureIssueDetailEditor()

  // 연결 추가: 카테고리 select
  const linkAddType = document.getElementById('detail-link-add-type')
  if (linkAddType) {
    on(linkAddType, 'change', () => {
      const m = state.issueDetailModal
      if (!m) return
      if (!m.addLink) m.addLink = { value: '', query: '', suggestions: [], searching: false }
      m.addLink.value = linkAddType.value
    })
  }

  // 연결 추가: 검색 input
  const linkAddSearch = document.getElementById('detail-link-add-search')
  if (linkAddSearch) {
    on(linkAddSearch, 'input', () => {
      const m = state.issueDetailModal
      if (!m) return
      if (!m.addLink) m.addLink = { value: linkAddType?.value || '', query: '', suggestions: [], searching: false }
      // select가 비어있으면 첫 옵션을 자동 선택
      if (!m.addLink.value && linkAddType) m.addLink.value = linkAddType.value
      m.addLink.query = linkAddSearch.value
      scheduleAddLinkSearch()
    })
  }
}

// _delegate에 등록되는 액션 핸들러들 (모듈 로드 시 1회)
// events.js의 bindEvents에서 일괄 register하는 패턴이지만, 도메인 응집을 위해 여기서 export.
export const detailLinkActions = {
  'open-linked-issue': (e, el) => {
    e.stopImmediatePropagation()
    const key = el.dataset.issueKey
    if (!key) return
    // 현재 모달 닫고 새 이슈로 전환. closeIssueDetailModal의 dirty 검사 흐름을 그대로 따른다.
    closeIssueDetailModal()
    // 닫기가 취소된 경우(state 그대로) 새 모달을 열지 않는다
    if (state.issueDetailModal) return
    openIssueDetailModal(key)
  },
  'remove-issue-link': async (e, el) => {
    e.stopImmediatePropagation()
    const linkId = el.dataset.linkId
    if (!linkId) return
    await removeIssueLink(linkId)
  },
  'pick-add-link-target': async (e, el) => {
    e.stopImmediatePropagation()
    const key = el.dataset.key
    if (!key) return
    await addIssueLinkTo(key)
  },
}
