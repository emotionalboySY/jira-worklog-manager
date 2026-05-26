// tiptap 에디터 초기화/파괴 래퍼
// 이슈 상세 모달의 설명 본문 + 댓글 작성/편집에 사용.
// - 본문 편집: 단일 currentEditor 싱글턴 (기존 호환)
// - 댓글: 작성기 + 편집기 등 동시 다중 인스턴스 지원 → mount element에 직접 보관

import { Editor, Extension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'
import { adfToPm, pmToAdf } from './adfProsemirror.js'
import { MediaSingle, Media, MediaPlaceholder, MediaPaste, setMountAttachments, releaseMountBlobUrls } from './tiptapMedia.js'

let currentEditor = null

// 현재 selection의 listItem 노드 정보 — 없으면 null
function findListItemAtSelection(editor) {
  const { $from } = editor.state.selection
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (node.type.name === 'listItem') {
      return { node, depth: d }
    }
  }
  return null
}

// 에디터 mount element id → 대응 저장 버튼 element
// (각 사용처별로 별도 마운트 id를 쓰고 있어 매핑 테이블로 일괄 처리)
function findSaveButtonForMount(mountEl) {
  if (!mountEl) return null
  const id = mountEl.id || ''
  if (id === 'create-issue-desc-editor') return document.getElementById('create-issue-submit')
  if (id === 'issue-detail-edit-editor') return document.getElementById('issue-detail-edit-save')
  if (id === 'detail-comment-compose-editor') return document.getElementById('detail-comment-submit')
  const editPrefix = 'detail-comment-edit-editor-'
  if (id.startsWith(editPrefix)) {
    const cid = id.slice(editPrefix.length)
    return document.querySelector(`[data-action="save-edit-comment"][data-comment-id="${CSS.escape(cid)}"]`)
  }
  return null
}

// 리스트 탈출 + 포커스 이탈 방지 + Jira 호환 단축키
// - Enter: 빈 listItem에서 한 번 더 누르면 lift (리스트 밖으로)
// - Backspace: 빈 listItem 시작 위치에서 lift
// - Tab/Shift-Tab: listItem 안이면 항상 처리 → 브라우저 포커스 이동 차단
// - Mod-Shift-s: 취소선 (Jira 호환)
// - Mod-k: 링크 (Jira 호환)
const EditorKeymap = Extension.create({
  name: 'editorKeymap',
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const editor = this.editor
        if (!editor.isActive('listItem')) return false
        const { empty } = editor.state.selection
        if (!empty) return false
        const li = findListItemAtSelection(editor)
        if (li && li.node.textContent === '') {
          return editor.commands.liftListItem('listItem')
        }
        return false
      },
      Backspace: () => {
        const editor = this.editor
        if (!editor.isActive('listItem')) return false
        const { $from, empty } = editor.state.selection
        if (!empty) return false
        const li = findListItemAtSelection(editor)
        // listItem이 비어있고, 자식 paragraph 시작 위치(parentOffset 0)면 lift
        if (li && li.node.textContent === '' && $from.parentOffset === 0) {
          return editor.commands.liftListItem('listItem')
        }
        return false
      },
      Tab: () => {
        const editor = this.editor
        if (editor.isActive('listItem')) {
          editor.commands.sinkListItem('listItem')
          // sink 불가(첫 항목 등)여도 true 반환 → 브라우저 포커스 이동 차단
          return true
        }
        return false
      },
      'Shift-Tab': () => {
        const editor = this.editor
        if (editor.isActive('listItem')) {
          editor.commands.liftListItem('listItem')
          return true
        }
        return false
      },
      'Mod-Shift-s': () => this.editor.commands.toggleStrike(),
      'Mod-k': () => {
        const url = window.prompt('링크 URL을 입력하세요:')
        if (url) this.editor.commands.setLink({ href: url })
        return true
      },
      // Ctrl/⌘ + Enter: 새 줄/문단 삽입 없이 대응 저장 버튼만 트리거
      'Mod-Enter': () => {
        const btn = findSaveButtonForMount(this.editor.options.element)
        if (btn && !btn.disabled) btn.click()
        return true
      },
    }
  },
})

// 공통 extension 구성
function buildExtensions() {
  return [
    StarterKit.configure({
      codeBlock: { HTMLAttributes: { class: 'tiptap-code-block' } },
      link: {
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      },
    }),
    EditorKeymap,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    MediaSingle,
    Media,
    MediaPlaceholder,
    MediaPaste,
  ]
}

// mountEl 위에 새 Editor 인스턴스를 생성. mount.__tt_editor에 저장.
// onUpdate: 매 변경 시 ADF로 콜백 (state 보존용)
// onImagePaste(file) → Promise<{ id, contentUrl, filename, ... }>
//   클립보드/드롭 이미지를 받아 첨부 업로드 후 결과 반환. 미지정 시 paste 무시.
// attachments: 편집 시작 시점의 첨부 목록 (id ↔ contentUrl 매핑)
// pendingPreviews: [{ id, file, filename }] — Jira에 아직 업로드되지 않은 임시 첨부.
//   재마운트 시에도 paste된 이미지가 보이도록 id별 blob URL을 재생성한다.
// onUploadError(err): 업로드 실패 시 토스트 등 표시
export function createEditorInstance(mountEl, adfContent, {
  onUpdate,
  autofocus = true,
  onImagePaste,
  attachments,
  pendingPreviews,
  onUploadError,
} = {}) {
  if (!mountEl) return null
  destroyInstanceOnMount(mountEl)
  const content = adfToPm(adfContent)

  // 이미지 paste/업로드 후크와 첨부 메타를 마운트에 주입
  if (typeof onImagePaste === 'function') mountEl.__tt_on_image_paste = onImagePaste
  if (typeof onUploadError === 'function') mountEl.__tt_on_upload_error = onUploadError
  if (attachments) setMountAttachments(mountEl, attachments)

  // 아직 업로드되지 않은 paste 이미지 — id별로 blob URL을 만들어 NodeView가
  // 즉시 미리보기를 띄울 수 있게 attachments/temp 맵에 함께 등록
  if (Array.isArray(pendingPreviews) && pendingPreviews.length > 0) {
    if (!mountEl.__tt_attachments_by_id) mountEl.__tt_attachments_by_id = {}
    if (!mountEl.__tt_temp_blob_urls) mountEl.__tt_temp_blob_urls = {}
    if (!mountEl.__tt_owned_blob_urls) mountEl.__tt_owned_blob_urls = []
    for (const p of pendingPreviews) {
      if (!p?.id || !p?.file) continue
      mountEl.__tt_attachments_by_id[p.id] = { contentUrl: '', filename: p.filename || '' }
      let url = null
      try { url = URL.createObjectURL(p.file) } catch {}
      if (url) {
        mountEl.__tt_temp_blob_urls[p.id] = url
        mountEl.__tt_owned_blob_urls.push(url)
      }
    }
  }

  const editor = new Editor({
    element: mountEl,
    extensions: buildExtensions(),
    editorProps: {
      attributes: { class: 'tiptap-content', spellcheck: 'false' },
      // 편집 중 링크 열기: Ctrl/⌘ + 클릭으로만 새 탭 열기 (일반 클릭은 캐럿 이동)
      handleClick: (_view, _pos, event) => {
        if (!(event.ctrlKey || event.metaKey)) return false
        const anchor = event.target?.closest?.('a[href]')
        if (!anchor) return false
        const href = anchor.getAttribute('href')
        if (!href) return false
        event.preventDefault()
        window.open(href, '_blank', 'noopener,noreferrer')
        return true
      },
    },
    onUpdate: () => {
      if (typeof onUpdate !== 'function') return
      try { onUpdate(pmToAdf(editor.getJSON())) } catch (e) { console.warn('[tiptap] onUpdate ADF 변환 실패:', e) }
    },
  })

  if (content && content.content && content.content.length > 0) {
    try {
      editor.commands.setContent(content, { emitUpdate: false })
    } catch (e) {
      console.warn('[tiptap] setContent JSON 실패, HTML 폴백:', e)
      try { editor.commands.setContent('<p></p>', { emitUpdate: false }) } catch {}
    }
  }

  mountEl.__tt_editor = editor
  if (autofocus) {
    setTimeout(() => { try { editor?.commands.focus('end') } catch {} }, 50)
  }
  return editor
}

export function getEditorOnMount(mountEl) {
  return mountEl?.__tt_editor || null
}

export function destroyInstanceOnMount(mountEl) {
  if (mountEl?.__tt_editor) {
    try { mountEl.__tt_editor.destroy() } catch {}
    mountEl.__tt_editor = null
    delete mountEl.dataset.tiptapMounted
  }
  // 이미지 paste로 만들어진 임시/실제 blob URL 정리 + 후크/캐시 해제
  if (mountEl) {
    releaseMountBlobUrls(mountEl)
    mountEl.__tt_on_image_paste = null
    mountEl.__tt_on_upload_error = null
    mountEl.__tt_attachments_by_id = null
  }
}

export function getInstanceAdf(editor) {
  if (!editor) return null
  try { return pmToAdf(editor.getJSON()) } catch { return null }
}

export function runCommandOnEditor(editor, name, ...args) {
  if (!editor) return
  const chain = editor.chain().focus()
  const fn = chain[name]
  if (typeof fn !== 'function') return
  fn.apply(chain, args).run()
}

// ===== 본문 편집(싱글턴) — 기존 인터페이스 유지 =====
// 이전 mount가 detached된 채 blob URL/후크가 남아 있을 수 있어 함께 정리.
let _previousMount = null
export function createEditor(mountEl, adfContent, options = {}) {
  destroyEditor()
  if (_previousMount && _previousMount !== mountEl) {
    try { releaseMountBlobUrls(_previousMount) } catch {}
    _previousMount.__tt_on_image_paste = null
    _previousMount.__tt_on_upload_error = null
    _previousMount.__tt_attachments_by_id = null
  }
  currentEditor = createEditorInstance(mountEl, adfContent, options)
  _previousMount = mountEl
  return currentEditor
}

export function getEditor() {
  return currentEditor
}

export function destroyEditor() {
  if (currentEditor) {
    try { currentEditor.destroy() } catch {}
    currentEditor = null
  }
  // 본문 편집기 종료 시 paste로 만들어진 blob URL/후크도 같이 정리
  if (_previousMount) {
    try { releaseMountBlobUrls(_previousMount) } catch {}
    _previousMount.__tt_on_image_paste = null
    _previousMount.__tt_on_upload_error = null
    _previousMount.__tt_attachments_by_id = null
    _previousMount = null
  }
}

export function getCurrentAdf() {
  return getInstanceAdf(currentEditor)
}

export function isActive(type, attrs) {
  if (!currentEditor) return false
  try { return currentEditor.isActive(type, attrs) } catch { return false }
}

export function setEditable(editable) {
  if (!currentEditor) return
  try { currentEditor.setEditable(!!editable) } catch {}
}

export function runCommand(name, ...args) {
  runCommandOnEditor(currentEditor, name, ...args)
}
