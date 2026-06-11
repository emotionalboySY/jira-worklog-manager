// tiptap 에디터 본체 — @tiptap 패키지를 실제로 import하는 유일한 모듈.
// 파사드(tiptap.js)가 최초 에디터 생성 시점에 dynamic import로 로드한다.
// 초기 번들에 에디터 코드가 들어가지 않도록 이 모듈을 정적으로 import하지 말 것.

import { Editor, Extension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'
import { adfToPm, pmToAdf } from './adfProsemirror.js'
import { MediaSingle, Media, MediaPlaceholder, MediaPaste } from './tiptapMedia.js'
import { setMountAttachments } from './tiptapMounts.js'
import { destroyInstanceOnMount } from './tiptap.js'

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
// 옵션/동작은 파사드의 createEditorInstance 문서 참조 (이 함수가 실제 구현).
export function buildEditorInstance(mountEl, adfContent, {
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
