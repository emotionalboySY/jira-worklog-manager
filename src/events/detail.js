// 이슈 상세 모달 — 열기/닫기, 설명(ADF) 본문 편집, 요약 인라인 편집, 첨부/이미지 로드.
// 댓글 영역은 comments.js로 분리. closeIssueDetailModal이 comments의 dirty 검사/정리 호출.
import { state } from '../state.js'
import {
  fetchIssueDetail,
  fetchAttachmentBlobUrl,
  updateIssueDescription,
  updateIssueSummary,
  uploadIssueAttachment,
  deleteIssueAttachment,
  fetchMyself,
  fetchIssueLinkTypes,
  fetchIssuesByKeys,
  createIssueLink,
  deleteIssueLink,
  searchIssuesByKey,
  normalizeMediaForSave,
  fetchIssueChangelog,
  fetchIssueMeta,
} from '../jira.js'
import { getProjectKeysOrFallback, formatJiraError, extractJiraIssueKeyFromUrl, getStatusCss, getProjectFromKey } from '../utils.js'
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
  if (m?.blobUrlCache) {
    for (const url of m.blobUrlCache.values()) {
      try { URL.revokeObjectURL(url) } catch {}
    }
  }
  state.issueDetailModal = null
  render({ sections: ['modals'] })
}

// ----- 설명 클릭 지점 → 에디터 커서 위치 매핑 -----
// 읽기 뷰와 에디터는 같은 ADF를 렌더하므로, 클릭 지점까지의 텍스트 문자 수를 세어
// 에디터 DOM에서 같은 문자 수 위치를 찾으면 클릭한 곳에 커서를 놓을 수 있다.
// 좌표 매핑(posAtCoords)은 양쪽의 여백/줄간격/내부 스크롤 차이로 어긋나서 쓰지 않는다.
// 에디터에서 다르게 렌더/제거되는 노드(스마트 링크·동영상·멘션·상태 라벨)는 양쪽 모두 계수에서 제외.
const CARET_SKIP_READ = '.adf-card, .adf-video, .adf-mention, .adf-status'
const CARET_SKIP_EDITOR = '[contenteditable="false"]'

// root 안의 텍스트 노드를 문서 순서로 순회. 공백뿐인 노드와 skipSelector 조상을 가진 노드는 제외.
function* countedTextNodes(root, skipSelector) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !node.nodeValue.trim()) continue
    if (node.parentElement?.closest(skipSelector)) continue
    yield node
  }
}

// 클릭 좌표가 가리키는 읽기 뷰 안의 caret 위치를 "앞선 텍스트 문자 수"로 환산.
// 캡처 불가(빈 설명, 지원 안 되는 브라우저, 영역 밖)면 null → 기존처럼 끝으로 포커스.
function captureDescriptionCaretIndex(point) {
  const descEl = document.getElementById('issue-detail-description')
  if (!descEl || descEl.classList.contains('detail-description-empty')) return null
  let container = null
  let offset = 0
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(point.x, point.y)
    if (r) { container = r.startContainer; offset = r.startOffset }
  } else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(point.x, point.y)
    if (p) { container = p.offsetNode; offset = p.offset }
  }
  if (!container || !descEl.contains(container)) return null
  // caret을 collapsed Range로 만들어 각 텍스트 노드가 caret 앞인지 뒤인지 판별
  const caret = document.createRange()
  try { caret.setStart(container, offset); caret.collapse(true) } catch { return null }
  let index = 0
  for (const node of countedTextNodes(descEl, CARET_SKIP_READ)) {
    if (node === container) return index + offset
    let cmp = 1
    try { cmp = caret.comparePoint(node, 0) } catch {}
    // 노드 시작이 caret 뒤 — 빈 문단/블록 사이를 클릭한 경우 여기서 확정
    if (cmp >= 0) return index
    index += node.nodeValue.length
  }
  return index // 마지막 텍스트 뒤를 클릭 → 본문 끝
}

// 에디터 텍스트의 index번째 문자 위치에 커서를 놓고 포커스. 실패하면 끝으로.
function focusEditorAtTextIndex(editor, index) {
  if (!editor || editor.isDestroyed) return
  let pos = null
  if (typeof index === 'number' && index >= 0) {
    let acc = 0
    for (const node of countedTextNodes(editor.view.dom, CARET_SKIP_EDITOR)) {
      const len = node.nodeValue.length
      if (acc + len >= index) {
        try { pos = editor.view.posAtDOM(node, index - acc) } catch { pos = null }
        break
      }
      acc += len
    }
  }
  try {
    if (typeof pos === 'number' && pos >= 0) editor.commands.focus(pos)
    else editor.commands.focus('end')
  } catch {
    try { editor.commands.focus('end') } catch {}
  }
}

// 편집 진입: editAdf에 현재 본문 복사 후 render → ensureTiptap이 마운트
// clickPoint({x, y})가 주어지면 읽기 뷰가 사라지기 전에 클릭 지점의 텍스트 오프셋을
// 캡처해 두고, 에디터 마운트 후 그 위치로 커서를 옮긴다.
export function enterIssueDetailEditMode(clickPoint) {
  const m = state.issueDetailModal
  if (!m || m.editing || m.loading) return
  const adf = m.data?.descriptionAdf
  m.editCaretIndex = clickPoint ? captureDescriptionCaretIndex(clickPoint) : null
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
  m.initialEditorAdf = undefined
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
    // 옛 이슈의 ADF media는 attrs.id가 Media Services UUID라 v3 PUT에서
    // INVALID_INPUT으로 거부됨. 첨부 numeric id로 정규화한 뒤 전송.
    const adfToSave = empty
      ? null
      : normalizeMediaForSave(adfDoc, m.data?.attachments || [])
    await updateIssueDescription(m.key, adfToSave)
    const fresh = await fetchIssueDetail(m.key)
    if (!state.issueDetailModal || state.issueDetailModal.key !== m.key) return
    destroyEditor()
    state.issueDetailModal.data = fresh || {}
    state.issueDetailModal.editing = false
    state.issueDetailModal.editAdf = null
    state.issueDetailModal.saving = false
    state.issueDetailModal.saveError = null
    state.issueDetailModal.lossyFeatures = null
    state.issueDetailModal.initialEditorAdf = undefined
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

// 에디터의 현재 ADF와 마운트 직후 캡처한 초기 ADF를 비교해 변경 여부 판단.
// 원본 m.data.descriptionAdf와 직접 비교하면 ADF↔ProseMirror 라운드트립으로
// 기본 attrs/마크가 정규화되어 항상 dirty로 보일 수 있어, 라운드트립 후 값을 기준으로 잡는다.
export function isEditorDirty() {
  const m = state.issueDetailModal
  if (!m) return false
  const current = getCurrentAdf()
  if (m.initialEditorAdf === undefined) return false
  return JSON.stringify(current) !== JSON.stringify(m.initialEditorAdf)
}

// 매 bindEvents 호출 후 실행: 편집 모드면 tiptap을 마운트
// 저장 중에도 외부 사정으로 재렌더가 일어날 수 있으므로 다시 마운트하되,
// 입력은 잠근 상태로 유지한다.
// createEditor가 async(tiptap 본체 lazy 로드)라 import 대기 중 재진입/상태 변화를 가드한다.
export async function ensureIssueDetailEditor() {
  const m = state.issueDetailModal
  if (!m?.editing) return
  const mount = document.getElementById('issue-detail-edit-editor')
  if (!mount || mount.dataset.tiptapMounted === '1' || mount.__tt_mounting) return
  mount.__tt_mounting = true
  let editor = null
  try {
    editor = await createEditor(mount, m.editAdf, {
      // 기본 autofocus('end') 대신 아래에서 클릭 지점(editCaretIndex)으로 직접 포커스
      autofocus: false,
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
            mediaId: result.mediaId || '',
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
        showToast(`첨부 업로드 실패: ${err?.message || '알 수 없는 오류'}`, '⚠')
      },
    })
  } catch (err) {
    console.error('[detail] 에디터 마운트 실패:', err)
    return
  } finally {
    mount.__tt_mounting = false
  }
  if (!editor) return  // import 대기 중 더 새로운 createEditor가 대체함
  // import 대기 중 편집 종료/모달 닫힘/mount 교체가 일어났으면 즉시 폐기
  if (state.issueDetailModal !== m || !m.editing || !mount.isConnected) {
    destroyEditor()
    return
  }
  if (m.saving) setEditable(false)
  mount.dataset.tiptapMounted = '1'
  // 라운드트립으로 정규화된 ADF를 dirty 비교의 기준으로 기록 (이미 있으면 유지)
  if (m.initialEditorAdf === undefined) {
    m.initialEditorAdf = getCurrentAdf()
  }
  // 편집 진입 클릭 지점으로 커서 이동 (1회성 — 재렌더로 인한 재마운트 시엔 기존처럼 끝으로).
  // 기존 autofocus와 같은 50ms 지연: 레이아웃/스크롤 복원이 끝난 뒤 포커스해야 안정적.
  const caretIndex = m.editCaretIndex
  m.editCaretIndex = null
  setTimeout(() => {
    if (state.issueDetailModal !== m || !m.editing) return
    focusEditorAtTextIndex(editor, caretIndex ?? -1)
  }, 50)
}

// 이슈 상세 모달 열기 + 상세 데이터 비동기 로드
export async function openIssueDetailModal(issueKey) {
  state.issueDetailModal = {
    key: issueKey, loading: true, data: null, error: null,
    // 이미지 로더 캐시 — 재렌더로 img가 교체돼도 동일 URL은 즉시 src 세팅
    blobUrlCache: new Map(),       // sourceUrl → blobUrl
    blobUrlInFlight: new Map(),    // sourceUrl → Promise<blobUrl|null>
    // 동영상 — 첨부 목록에서 재생 중인 첨부 id, 재렌더 후 이어재생용 재생 위치
    videoAttachmentId: null,
    videoState: new Map(),         // sourceUrl → { time, playing }
    linkTypes: null, addLink: null, linkRemoving: new Set(),
    // 댓글/기록 탭 — 'comments' | 'history'. 기록 탭 진입 시 lazy-load.
    activeTab: 'comments',
    history: { entries: [], total: 0, startAt: 0, isLast: true, loading: false, loaded: false, error: null },
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

// 한 source URL에 대해 캐시된 blob URL을 보장 (캐시 적중 → 즉시 반환, in-flight면 공유)
function ensureBlobUrl(m, sourceUrl) {
  if (!m || !sourceUrl) return Promise.resolve(null)
  const cached = m.blobUrlCache.get(sourceUrl)
  if (cached) return Promise.resolve(cached)
  const inFlight = m.blobUrlInFlight.get(sourceUrl)
  if (inFlight) return inFlight
  const p = fetchAttachmentBlobUrl(sourceUrl).then(blobUrl => {
    m.blobUrlInFlight.delete(sourceUrl)
    // 모달이 이미 닫혔거나 다른 이슈로 교체됐으면 캐시에 못 넣으므로 즉시 해제 (누수 방지)
    if (blobUrl && state.issueDetailModal !== m) {
      try { URL.revokeObjectURL(blobUrl) } catch {}
      return null
    }
    if (blobUrl) m.blobUrlCache.set(sourceUrl, blobUrl)
    return blobUrl
  }).catch(err => {
    m.blobUrlInFlight.delete(sourceUrl)
    console.warn('이미지 fetch 실패:', err)
    return null
  })
  m.blobUrlInFlight.set(sourceUrl, p)
  return p
}

// 본문 설명/댓글의 <img>와 첨부 썸네일을 인증 프록시로 받아 Blob URL로 교체.
// bindDetailModalEvents에서 매 재렌더마다 호출 → 재렌더로 교체된 img도 캐시 적중하면
// 즉시 src 세팅, 첫 진입이면 fetch 한 번만 발사 후 결과 공유.
export function loadIssueDetailImages() {
  const m = state.issueDetailModal
  if (!m || !m.blobUrlCache) return
  const modal = document.getElementById('issue-detail-overlay')
  if (!modal) return
  const modalKey = m.key

  // ADF media 노드 (description + 댓글 본문)
  const mediaImgs = modal.querySelectorAll(
    '.detail-description img[data-adf-media-url], .detail-comment-body img[data-adf-media-url]'
  )
  mediaImgs.forEach(img => {
    const url = img.getAttribute('data-adf-media-url')
    img.removeAttribute('data-adf-media-url')
    if (!url) {
      img.classList.add('detail-img-error')
      img.alt = '(이미지 원본을 찾지 못함)'
      return
    }
    const cached = m.blobUrlCache.get(url)
    if (cached) {
      img.src = cached
      return
    }
    img.classList.add('detail-img-loading')
    ensureBlobUrl(m, url).then(blobUrl => {
      if (!state.issueDetailModal || state.issueDetailModal.key !== modalKey) return
      if (blobUrl) {
        img.src = blobUrl
      } else {
        img.classList.add('detail-img-error')
        img.alt = '(이미지 로드 실패)'
      }
      img.classList.remove('detail-img-loading')
    })
  })

  // 첨부 썸네일
  const thumbs = modal.querySelectorAll('.detail-attachment-thumb[data-thumb-url]')
  thumbs.forEach(thumb => {
    const url = thumb.getAttribute('data-thumb-url')
    if (!url) return
    thumb.removeAttribute('data-thumb-url')
    const cached = m.blobUrlCache.get(url)
    if (cached) {
      thumb.style.backgroundImage = `url("${cached}")`
      return
    }
    thumb.classList.add('detail-img-loading')
    ensureBlobUrl(m, url).then(blobUrl => {
      if (!state.issueDetailModal || state.issueDetailModal.key !== modalKey) return
      if (blobUrl) {
        thumb.style.backgroundImage = `url("${blobUrl}")`
      } else {
        thumb.classList.add('detail-img-error')
      }
      thumb.classList.remove('detail-img-loading')
    })
  })

  // 동영상 플레이어 (본문 ADF media + 첨부 플레이어 패널)
  bindIssueDetailVideos()

  // 본문/댓글의 스마트 링크(같은 사이트 이슈)를 리치 카드로 교체
  resolveIssueDetailCards()
}

// 동영상 플레이어 바인딩. 이미지와 달리 자동으로 받지 않는다 — 영상은 수십 MB라
// 상세를 열자마자 통째로 내려받으면 느리고 프록시 트래픽도 낭비된다.
// 표지를 누른 시점에만 Blob URL을 받아 <video>에 물린다.
function bindIssueDetailVideos() {
  const m = state.issueDetailModal
  if (!m) return
  const modal = document.getElementById('issue-detail-overlay')
  if (!modal) return
  // 모달은 댓글 로드/폴링 등으로 자주 재렌더되어 <video>가 새 엘리먼트로 교체된다.
  // 재생 위치를 url별로 남겨 두었다가 새 엘리먼트에서 이어 재생한다.
  if (!m.videoState) m.videoState = new Map()  // url → { time, playing }

  modal.querySelectorAll('.adf-video[data-adf-video-url]').forEach(wrap => {
    const url = wrap.dataset.adfVideoUrl
    const video = wrap.querySelector('video')
    if (!url || !video) return

    on(video, 'timeupdate', () => {
      const st = m.videoState.get(url) || {}
      st.time = video.currentTime
      m.videoState.set(url, st)
    })
    on(video, 'play', () => {
      const st = m.videoState.get(url) || {}
      st.playing = true
      m.videoState.set(url, st)
    })
    on(video, 'pause', () => {
      const st = m.videoState.get(url) || {}
      st.playing = false
      m.videoState.set(url, st)
    })
    // mkv/avi/wmv 등 브라우저가 디코드 못 하는 코덱 — 다운로드로 안내
    on(video, 'error', () => {
      wrap.classList.remove('is-loading')
      wrap.classList.add('is-error')
      if (!wrap.querySelector('.adf-video-error')) {
        const msg = document.createElement('div')
        msg.className = 'adf-video-error'
        msg.textContent = '이 형식은 브라우저에서 재생할 수 없습니다. 첨부파일을 내려받아 확인하세요.'
        wrap.appendChild(msg)
      }
    })

    const prev = m.videoState.get(url)
    // 이미 한 번 재생을 시작했거나(재렌더 복원) 첨부 패널로 막 열린 경우엔 바로 로드
    if (prev || wrap.dataset.autoplay === '1') {
      startIssueDetailVideo(wrap, url, prev)
      return
    }
    const cover = wrap.querySelector('.adf-video-cover')
    if (cover) on(cover, 'click', () => startIssueDetailVideo(wrap, url, null))
  })
}

// 표지 클릭/복원 시점에 Blob URL을 받아 <video>에 물리고 재생을 시작한다.
async function startIssueDetailVideo(wrap, url, prev) {
  const m = state.issueDetailModal
  if (!m) return
  const video = wrap.querySelector('video')
  if (!video || video.src || wrap.dataset.loading === '1') return

  const modalKey = m.key
  wrap.dataset.loading = '1'
  wrap.classList.add('is-loading')

  const blobUrl = await ensureBlobUrl(m, url)
  delete wrap.dataset.loading
  // 로딩 중 모달이 닫혔거나 다른 이슈로 바뀌었으면 버린다
  if (!state.issueDetailModal || state.issueDetailModal.key !== modalKey) return
  if (!document.body.contains(wrap)) return

  wrap.classList.remove('is-loading')
  if (!blobUrl) {
    wrap.classList.add('is-error')
    showToast('동영상을 불러오지 못했습니다.', '⚠')
    return
  }

  wrap.classList.add('is-loaded')
  // 메타데이터가 올라온 뒤에야 currentTime을 옮길 수 있다 — src보다 먼저 걸어둔다
  if (prev?.time > 0) {
    on(video, 'loadedmetadata', () => { try { video.currentTime = prev.time } catch {} })
  }
  video.src = blobUrl
  // 첫 재생(prev 없음)이거나 재렌더 전 재생 중이었으면 이어서 재생
  if (!prev || prev.playing) {
    video.play().catch(() => {})  // 자동재생 차단 시엔 컨트롤로 직접 재생
  }
}

// 설명/댓글 본문의 스마트 링크 앵커(a.adf-card[data-adf-card-url])를 검사해
// 같은 사이트 이슈면 fetchIssueMeta로 키/제목/상태를 받아 리치 카드로 교체.
// 결과는 modal 캐시에 저장 → 재렌더 시 네트워크 재요청 없이 즉시 반영.
function resolveIssueDetailCards() {
  const m = state.issueDetailModal
  if (!m) return
  const modal = document.getElementById('issue-detail-overlay')
  if (!modal) return
  const modalKey = m.key
  if (!m.cardMetaCache) m.cardMetaCache = new Map()      // issueKey → meta | null
  if (!m.cardMetaInFlight) m.cardMetaInFlight = new Map() // issueKey → Promise<meta|null>

  const cards = modal.querySelectorAll(
    '.detail-description a.adf-card[data-adf-card-url], .detail-comment-body a.adf-card[data-adf-card-url]'
  )
  cards.forEach(a => {
    const url = a.getAttribute('data-adf-card-url')
    a.removeAttribute('data-adf-card-url') // 재처리 방지 (재렌더 시 새 앵커로 다시 붙음)
    if (!url) return
    const key = extractJiraIssueKeyFromUrl(url)
    if (!key) return // 외부/타사이트 링크는 기본 링크 칩 그대로 유지

    const cached = m.cardMetaCache.get(key)
    if (cached !== undefined) {
      if (cached) applyIssueCard(a, cached)
      return
    }

    a.classList.add('adf-card-loading')
    let p = m.cardMetaInFlight.get(key)
    if (!p) {
      p = fetchIssueMeta(key)
        .then(meta => { m.cardMetaInFlight.delete(key); m.cardMetaCache.set(key, meta || null); return meta || null })
        .catch(() => { m.cardMetaInFlight.delete(key); m.cardMetaCache.set(key, null); return null })
      m.cardMetaInFlight.set(key, p)
    }
    p.then(meta => {
      if (!state.issueDetailModal || state.issueDetailModal.key !== modalKey) return
      a.classList.remove('adf-card-loading')
      if (meta) applyIssueCard(a, meta)
    })
  })
}

// 스마트 링크 앵커 내용을 이슈 리치 카드(키/제목/상태)로 채운다. href는 그대로 두어 클릭 시 Jira로 이동.
function applyIssueCard(a, meta) {
  a.textContent = ''
  a.classList.add('adf-card-resolved')

  const keyEl = document.createElement('span')
  keyEl.className = 'adf-card-key issue-key'
  keyEl.dataset.project = getProjectFromKey(meta.key)
  keyEl.textContent = meta.key
  a.appendChild(keyEl)

  const sum = document.createElement('span')
  sum.className = 'adf-card-summary'
  sum.textContent = meta.summary || ''
  a.appendChild(sum)

  if (meta.status) {
    const st = document.createElement('span')
    st.className = `adf-card-status issue-status ${getStatusCss(meta.statusCategory)}`
    st.textContent = meta.status
    a.appendChild(st)
  }
  a.title = `${meta.key} · ${meta.summary || ''}`
}

// closeIssueDetailModal의 ESC 흐름에서 댓글 작성기/편집기 취소도 같이 처리되도록 재export
export { cancelCommentCompose, cancelEditComment }

// mousedown 위치를 기록해 두고 click 시점에 이동거리/선택 상태를 검사.
// 드래그(>4px) 또는 텍스트 선택이 발생한 경우 콜백을 호출하지 않아 텍스트 드래그 선택을 보존한다.
function bindClickWithoutDrag(el, handler) {
  let start = null
  on(el, 'mousedown', (e) => {
    if (e.button !== 0) { start = null; return }
    start = { x: e.clientX, y: e.clientY }
  })
  on(el, 'click', (e) => {
    const s = start
    start = null
    // 드래그 이동량 검사
    if (s) {
      const dx = Math.abs(e.clientX - s.x)
      const dy = Math.abs(e.clientY - s.y)
      if (dx > 4 || dy > 4) return
    }
    // 텍스트 선택이 el 내부에서 발생했으면 편집 진입 차단
    const sel = window.getSelection?.()
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0)
      if (el.contains(range.commonAncestorContainer)) return
    }
    handler(e)
  })
}

// 활동 기록 한 페이지 로드. 'append'면 기존 entries 뒤에 이어붙임(더보기).
async function loadIssueHistory({ append = false } = {}) {
  const m = state.issueDetailModal
  if (!m || !m.key) return
  if (!m.history) m.history = { entries: [], total: 0, startAt: 0, isLast: true, loading: false, loaded: false, error: null }
  if (m.history.loading) return
  const issueKey = m.key
  const startAt = append ? (m.history.entries.length) : 0
  m.history.loading = true
  m.history.error = null
  // 첫 로드는 스피너만, 더보기는 버튼 disabled 표시를 위해 재렌더
  render({ sections: ['modals'] })
  try {
    const res = await fetchIssueChangelog(issueKey, { startAt, maxResults: 50 })
    const cur = state.issueDetailModal
    if (!cur || cur.key !== issueKey) return
    const next = append ? [...(cur.history.entries || []), ...res.entries] : res.entries
    cur.history = {
      entries: next,
      total: res.total,
      startAt: res.startAt,
      isLast: res.isLast,
      loading: false,
      loaded: true,
      error: null,
    }
    render({ sections: ['modals'] })
  } catch (err) {
    const cur = state.issueDetailModal
    if (!cur || cur.key !== issueKey) return
    cur.history.loading = false
    cur.history.error = err?.message || '알 수 없는 오류'
    render({ sections: ['modals'] })
  }
}

// 첨부를 인증 프록시로 받아 브라우저 다운로드 트리거 (새 탭을 열지 않음).
// el은 진행 상태 표시용 — 없어도 동작한다.
async function downloadAttachment(el, url, filename) {
  if (!url) return
  if (el?.dataset.downloading === '1') return  // 받는 중 중복 클릭 방지
  if (el) {
    el.dataset.downloading = '1'
    el.classList.add('is-downloading')
  }
  try {
    const blobUrl = await fetchAttachmentBlobUrl(url)
    if (!blobUrl) { showToast('첨부파일을 불러오지 못했습니다.', '⚠'); return }
    // 임시 <a download>으로 브라우저 다운로드를 트리거 (탭 전환 없음)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = filename || 'download'
    document.body.appendChild(a)
    a.click()
    a.remove()
    // 다운로드가 시작될 시간을 준 뒤 blob URL 해제 (메모리 누수 방지)
    setTimeout(() => { try { URL.revokeObjectURL(blobUrl) } catch {} }, 60000)
  } finally {
    if (el) {
      delete el.dataset.downloading
      el.classList.remove('is-downloading')
    }
  }
}

// 첨부 목록 아래 동영상 플레이어 패널 열기/닫기
function openAttachmentVideo(attachmentId) {
  const m = state.issueDetailModal
  if (!m || !attachmentId) return
  if (String(m.videoAttachmentId) === String(attachmentId)) return
  m.videoAttachmentId = String(attachmentId)
  render({ sections: ['modals'] })
}

function closeAttachmentVideo() {
  const m = state.issueDetailModal
  if (!m || !m.videoAttachmentId) return
  m.videoAttachmentId = null
  render({ sections: ['modals'] })
}

// 댓글/기록 탭 전환. history 탭 처음 진입 시 lazy-load.
function switchActivityTab(tab) {
  const m = state.issueDetailModal
  if (!m) return
  const next = tab === 'history' ? 'history' : 'comments'
  if (m.activeTab === next) return
  m.activeTab = next
  render({ sections: ['modals'] })
  if (next === 'history' && !m.history?.loaded && !m.history?.loading) {
    loadIssueHistory({ append: false })
  }
}

// 상세 모달의 버튼/클릭 바인딩 (modals 섹션 재렌더 시마다 호출)
export function bindDetailModalEvents() {
  // 닫기 버튼들
  const detailCloseBtn = document.getElementById('issue-detail-close')
  if (detailCloseBtn) on(detailCloseBtn, 'click', closeIssueDetailModal)
  const detailCloseFooterBtn = document.getElementById('issue-detail-close-footer')
  if (detailCloseFooterBtn) on(detailCloseFooterBtn, 'click', closeIssueDetailModal)

  // 첨부 클릭 → 인증 프록시로 받아 바로 다운로드 (새 탭을 열지 않음)
  // 단, 동영상 첨부는 다운로드 대신 목록 아래 플레이어 패널을 연다.
  document.querySelectorAll('#issue-detail-overlay .detail-attachment').forEach(el => {
    on(el, 'click', async (e) => {
      e.preventDefault()
      if (el.dataset.video === '1') {
        openAttachmentVideo(el.dataset.attachmentId)
        return
      }
      await downloadAttachment(el, el.dataset.attachmentUrl, el.dataset.filename)
    })
  })

  // 설명 영역 클릭 → 편집 모드 진입 (단, 드래그로 텍스트 선택 중이면 진입 차단)
  const detailDescEl = document.getElementById('issue-detail-description')
  if (detailDescEl) {
    bindClickWithoutDrag(detailDescEl, (e) => {
      // 설명 내부 링크/이미지/동영상 클릭은 기본 동작 유지 (재생 중 편집 진입 방지)
      if (e.target.closest('a, img, .adf-video')) return
      // 클릭 좌표를 넘겨 편집 진입 시 그 지점에 커서가 놓이게 한다
      enterIssueDetailEditMode({ x: e.clientX, y: e.clientY })
    })
  }

  // 요약 영역 클릭 → 인라인 편집 모드 진입 (드래그 선택 시 진입 차단)
  const detailSummaryEl = document.getElementById('issue-detail-summary')
  if (detailSummaryEl) bindClickWithoutDrag(detailSummaryEl, enterSummaryEdit)

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

  // 재렌더로 교체된 본문/댓글 img들에 캐시된 blob URL을 즉시 적용 (없으면 fetch)
  loadIssueDetailImages()

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

  // 댓글/활동 기록 탭 전환
  document.querySelectorAll('#issue-detail-overlay .detail-activity-tab').forEach(btn => {
    on(btn, 'click', () => {
      const tab = btn.dataset.activityTab
      if (!tab) return
      switchActivityTab(tab)
    })
  })

  // 활동 기록 '이전 기록 더보기'
  const historyMoreBtn = document.getElementById('detail-history-load-more')
  if (historyMoreBtn) on(historyMoreBtn, 'click', () => loadIssueHistory({ append: true }))

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
  'remove-attachment': async (e, el) => {
    e.preventDefault()
    e.stopImmediatePropagation()
    const id = el.dataset.attachmentId
    const filename = el.dataset.filename || ''
    if (!id) return
    await removeIssueAttachment(id, filename)
  },
  'add-attachment': (e, el) => {
    e.preventDefault()
    e.stopImmediatePropagation()
    triggerAttachmentUpload()
  },
  'download-attachment': async (e, el) => {
    e.preventDefault()
    e.stopImmediatePropagation()
    await downloadAttachment(el, el.dataset.attachmentUrl, el.dataset.filename)
  },
  'close-attachment-video': (e) => {
    e.preventDefault()
    e.stopImmediatePropagation()
    closeAttachmentVideo()
  },
}

// 첨부 삭제: 확인 → API → 모달 상태에서 제거 → 재렌더
async function removeIssueAttachment(attachmentId, filename) {
  const m = state.issueDetailModal
  if (!m) return
  if (!m.attachmentRemoving) m.attachmentRemoving = new Set()
  if (m.attachmentRemoving.has(attachmentId)) return
  const label = filename ? `'${filename}'` : '이 첨부파일'
  if (!window.confirm(`${label}을(를) 삭제하시겠습니까? 되돌릴 수 없습니다.`)) return
  m.attachmentRemoving.add(attachmentId)
  render({ sections: ['modals'] })
  try {
    await deleteIssueAttachment(attachmentId)
    const cur = state.issueDetailModal
    if (cur && cur.key === m.key && Array.isArray(cur.data?.attachments)) {
      cur.data.attachments = cur.data.attachments.filter(a => String(a.id) !== String(attachmentId))
    }
    showToast('첨부파일을 삭제했습니다.', '✓')
  } catch (err) {
    console.error('첨부 삭제 실패:', err)
    showToast(`첨부 삭제 실패: ${formatJiraError(err)}`, '⚠')
  } finally {
    if (state.issueDetailModal?.attachmentRemoving) {
      state.issueDetailModal.attachmentRemoving.delete(attachmentId)
    }
    render({ sections: ['modals'] })
  }
}

// 첨부 추가: 숨겨진 file input을 열어 선택된 파일을 업로드 후 모달 상태에 반영
function triggerAttachmentUpload() {
  const m = state.issueDetailModal
  if (!m || !m.key) return
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.style.display = 'none'
  document.body.appendChild(input)
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || [])
    document.body.removeChild(input)
    if (files.length === 0) return
    await uploadAttachmentsToDetail(files)
  })
  input.click()
}

async function uploadAttachmentsToDetail(files) {
  const m = state.issueDetailModal
  if (!m || !m.key) return
  const issueKey = m.key
  m.attachmentUploading = (m.attachmentUploading || 0) + files.length
  render({ sections: ['modals'] })
  let okCount = 0
  let failCount = 0
  for (const file of files) {
    try {
      const result = await uploadIssueAttachment(issueKey, file)
      const cur = state.issueDetailModal
      if (cur && cur.key === issueKey) {
        if (!cur.data) cur.data = {}
        if (!Array.isArray(cur.data.attachments)) cur.data.attachments = []
        cur.data.attachments.push({
          id: result.id,
          mediaId: result.mediaId || '',
          filename: result.filename,
          mimeType: result.mimeType,
          size: result.size,
          contentUrl: result.contentUrl,
          thumbnailUrl: result.thumbnailUrl,
        })
      }
      okCount++
    } catch (err) {
      console.error('첨부 업로드 실패:', err, file?.name)
      failCount++
    } finally {
      if (state.issueDetailModal) {
        state.issueDetailModal.attachmentUploading = Math.max(0, (state.issueDetailModal.attachmentUploading || 0) - 1)
      }
      render({ sections: ['modals'] })
    }
  }
  loadIssueDetailImages()
  if (okCount > 0) showToast(`첨부 ${okCount}개를 추가했습니다.`, '✓')
  if (failCount > 0) showToast(`${failCount}개 업로드 실패`, '⚠')
}
