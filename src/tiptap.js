// tiptap 에디터 초기화/파괴 래퍼
// 이슈 상세 모달에서만 사용. 편집 진입 시 생성하고 종료 시 파괴한다.

import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
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
    ],
    editorProps: {
      attributes: {
        class: 'tiptap-content',
        spellcheck: 'false',
      },
    },
  })

  // 생성 후 명시적으로 content 주입 (생성자 content 옵션이 일부 환경에서 무시되는 케이스 방지)
  if (content && content.content && content.content.length > 0) {
    try {
      currentEditor.commands.setContent(content, { emitUpdate: false })
    } catch (e) {
      // 스키마 검증 실패 시 HTML로 폴백 시도 (거의 없지만 안전망)
      console.warn('[tiptap] setContent JSON 실패, HTML 폴백:', e)
      try {
        const html = currentEditor.storage?.doc?.toHTML?.() ?? ''
        currentEditor.commands.setContent(html || '<p></p>', { emitUpdate: false })
      } catch {}
    }
  }

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

// 에디터 입력 활성/비활성 토글 (저장 중 잠금용)
export function setEditable(editable) {
  if (!currentEditor) return
  try { currentEditor.setEditable(!!editable) } catch {}
}

// 에디터 명령 실행 (editor.chain().focus().X().run() 래퍼)
export function runCommand(name, ...args) {
  if (!currentEditor) return
  const chain = currentEditor.chain().focus()
  const fn = chain[name]
  if (typeof fn !== 'function') return
  fn.apply(chain, args).run()
}
