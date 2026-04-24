// tiptap 에디터 초기화/파괴 래퍼
// 이슈 상세 모달에서만 사용. 편집 진입 시 생성하고 종료 시 파괴한다.

import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Link } from '@tiptap/extension-link'
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'
import { adfToPm, pmToAdf } from './adfProsemirror.js'

let currentEditor = null

export function createEditor(mountEl, adfContent) {
  destroyEditor()
  const content = adfToPm(adfContent)
  currentEditor = new Editor({
    element: mountEl,
    extensions: [
      StarterKit.configure({
        // codeBlock는 StarterKit에 포함. 언어 속성 유지.
        codeBlock: { HTMLAttributes: { class: 'tiptap-code-block' } },
      }),
      Link.configure({
        openOnClick: false,   // 편집 중엔 클릭으로 이동 금지
        autolink: true,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content,
    editorProps: {
      attributes: {
        class: 'tiptap-content',
        spellcheck: 'false',
      },
    },
  })
  // 포커스는 약간 지연 (모달 애니메이션 종료 후)
  setTimeout(() => {
    try { currentEditor?.commands.focus('end') } catch {}
  }, 50)
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

// 현재 에디터 내용을 ADF로 추출
export function getCurrentAdf() {
  if (!currentEditor) return null
  const pm = currentEditor.getJSON()
  return pmToAdf(pm)
}

// 툴바 버튼의 활성/비활성 상태 갱신용: 현재 선택된 부분에 해당 서식이 걸려 있는지
export function isActive(type, attrs) {
  if (!currentEditor) return false
  try { return currentEditor.isActive(type, attrs) } catch { return false }
}

// 에디터 명령 실행 (editor.chain().focus().X().run() 래퍼)
export function runCommand(name, ...args) {
  if (!currentEditor) return
  const chain = currentEditor.chain().focus()
  const fn = chain[name]
  if (typeof fn !== 'function') return
  fn.apply(chain, args).run()
}
