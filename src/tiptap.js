// tiptap 에디터 초기화/파괴 래퍼
// 이슈 상세 모달의 설명 본문 + 댓글 작성/편집에 사용.
// - 본문 편집: 단일 currentEditor 싱글턴 (기존 호환)
// - 댓글: 작성기 + 편집기 등 동시 다중 인스턴스 지원 → mount element에 직접 보관

import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'
import { adfToPm, pmToAdf } from './adfProsemirror.js'

let currentEditor = null

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
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
  ]
}

// mountEl 위에 새 Editor 인스턴스를 생성. mount.__tt_editor에 저장.
// onUpdate: 매 변경 시 ADF로 콜백 (state 보존용)
export function createEditorInstance(mountEl, adfContent, { onUpdate, autofocus = true } = {}) {
  if (!mountEl) return null
  destroyInstanceOnMount(mountEl)
  const content = adfToPm(adfContent)

  const editor = new Editor({
    element: mountEl,
    extensions: buildExtensions(),
    editorProps: {
      attributes: { class: 'tiptap-content', spellcheck: 'false' },
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
export function createEditor(mountEl, adfContent) {
  destroyEditor()
  currentEditor = createEditorInstance(mountEl, adfContent)
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
