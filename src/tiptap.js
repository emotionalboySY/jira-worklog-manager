// tiptap 에디터 파사드 — @tiptap 본체를 정적으로 import하지 않는다.
// 무거운 구현(tiptapEditor.js: Editor 생성 + extensions + media 노드/플러그인)은
// 최초 에디터 생성 시점에 dynamic import로 로드해 초기 번들에서 제외한다.
// 이미 생성된 인스턴스에 대한 접근/조작/파괴는 이 모듈에서 동기적으로 처리.
//
// - 본문 편집: 단일 currentEditor 싱글턴 (기존 호환)
// - 댓글/새 일감: 동시 다중 인스턴스 → mount element(__tt_editor)에 직접 보관

import { pmToAdf } from './adfProsemirror.js'
import { releaseMountBlobUrls } from './tiptapMounts.js'

let currentEditor = null

// tiptapEditor.js 모듈 로더 (1회 import 후 캐시)
let _editorModuleLoader = null
function loadEditorModule() {
  if (!_editorModuleLoader) _editorModuleLoader = import('./tiptapEditor.js')
  return _editorModuleLoader
}

// (async) mountEl 위에 새 Editor 인스턴스를 생성. mount.__tt_editor에 저장.
// onUpdate: 매 변경 시 ADF로 콜백 (state 보존용)
// onImagePaste(file) → Promise<{ id, contentUrl, filename, ... }>
//   클립보드/드롭 이미지를 받아 첨부 업로드 후 결과 반환. 미지정 시 paste 무시.
// attachments: 편집 시작 시점의 첨부 목록 (id ↔ contentUrl 매핑)
// pendingPreviews: [{ id, file, filename }] — Jira에 아직 업로드되지 않은 임시 첨부.
//   재마운트 시에도 paste된 이미지가 보이도록 id별 blob URL을 재생성한다.
// onUploadError(err): 업로드 실패 시 토스트 등 표시
export async function createEditorInstance(mountEl, adfContent, options = {}) {
  if (!mountEl) return null
  const { buildEditorInstance } = await loadEditorModule()
  return buildEditorInstance(mountEl, adfContent, options)
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

// ===== 본문 편집(싱글턴) — 기존 인터페이스 유지 (단, createEditor는 async) =====
// 이전 mount가 detached된 채 blob URL/후크가 남아 있을 수 있어 함께 정리.
let _previousMount = null
// dynamic import 대기 중 더 새로운 createEditor가 시작되면 이전 호출 결과는 폐기
let _createSeq = 0
export async function createEditor(mountEl, adfContent, options = {}) {
  const seq = ++_createSeq
  destroyEditor()
  if (_previousMount && _previousMount !== mountEl) {
    try { releaseMountBlobUrls(_previousMount) } catch {}
    _previousMount.__tt_on_image_paste = null
    _previousMount.__tt_on_upload_error = null
    _previousMount.__tt_attachments_by_id = null
  }
  const editor = await createEditorInstance(mountEl, adfContent, options)
  if (seq !== _createSeq) {
    // 이 호출이 await하는 사이 더 새로운 createEditor가 진행됨 — 이 인스턴스는 폐기
    try { editor?.destroy() } catch {}
    releaseMountBlobUrls(mountEl)
    return null
  }
  currentEditor = editor
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
