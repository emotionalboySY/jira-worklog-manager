// 이슈 설명/댓글 에디터에서 사용할 커스텀 미디어 노드.
// - 클립보드 이미지 paste(또는 drop) 시 Jira에 첨부 업로드 후 mediaSingle > media 노드 삽입
// - NodeView에서 인증 프록시로 이미지를 받아 표시 + 우측 드래그 핸들로 크기 조절
//
// ADF 스키마(원본)를 그대로 PM 스키마로도 사용한다:
//   mediaSingle { layout, width(%) } > media { id, type, collection, width(px), height(px), alt }
//
// 마운트 엘리먼트에 다음 프로퍼티를 부착해 NodeView/플러그인과 통신한다:
//   __tt_on_image_paste(file) → Promise<{ id, contentUrl, filename, ... }>
//   __tt_attachments_by_id[id] → { contentUrl, filename } (저장된 첨부 메타)
//   __tt_temp_blob_urls[id]   → string (paste 직후 임시 표시용 blob URL)
//   __tt_owned_blob_urls      → string[] (에디터 파괴 시 일괄 revoke)
//   __tt_on_upload_error(err) → toast 표시 등 호출자 후크

import { Node, Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { fetchAttachmentBlobUrl } from './jira.js'

// ---------- mediaSingle: 이미지 컨테이너 (블록) ----------
export const MediaSingle = Node.create({
  name: 'mediaSingle',
  group: 'block',
  content: 'media',
  selectable: true,
  draggable: true,
  isolating: true,

  addAttributes() {
    return {
      layout: { default: 'center' },
      width: { default: null }, // % (선택)
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-media-single]' }]
  },

  renderHTML({ node }) {
    const attrs = { 'data-media-single': '', class: 'tt-media-single' }
    if (node.attrs.layout) attrs['data-layout'] = node.attrs.layout
    if (node.attrs.width) attrs['data-width'] = String(node.attrs.width)
    return ['div', attrs, 0]
  },

  addNodeView() {
    return ({ node, getPos, editor }) => new MediaSingleView(node, getPos, editor)
  },
})

// ---------- media: mediaSingle 내부의 실제 이미지 노드 (atom 블록) ----------
// ProseMirror에서 "블록 노드가 단일 inline atom을 자식으로 두는" 패턴이 까다로워
// media도 블록 atom으로 선언한다. mediaSingle은 content: 'media'로 그대로 유지.
export const Media = Node.create({
  name: 'media',
  group: 'block',
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      id: { default: null },
      type: { default: 'file' },
      collection: { default: '' },
      width: { default: null },   // px
      height: { default: null },  // px
      alt: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-media-id]' }]
  },

  renderHTML({ node }) {
    return ['div', { 'data-media-id': node.attrs.id || '', class: 'tt-media-leaf' }]
  },
})

// ---------- mediaSingle용 NodeView ----------
class MediaSingleView {
  constructor(node, getPos, editor) {
    this.node = node
    this.getPos = getPos
    this.editor = editor

    const wrap = document.createElement('div')
    wrap.className = 'tt-media-wrap'
    wrap.contentEditable = 'false'
    this._applyWidth(wrap, node.attrs.width)

    const img = document.createElement('img')
    img.className = 'tt-media-img'
    img.draggable = false
    wrap.appendChild(img)
    this.img = img

    const handle = document.createElement('span')
    handle.className = 'tt-media-handle'
    handle.contentEditable = 'false'
    handle.title = '드래그하여 크기 조절'
    wrap.appendChild(handle)
    this.handle = handle

    // ProseMirror가 media 자식의 DOM을 여기에 둠 (시각적으로는 숨김)
    const hidden = document.createElement('div')
    hidden.className = 'tt-media-content-hidden'
    hidden.style.display = 'none'
    wrap.appendChild(hidden)
    this.contentDOM = hidden

    handle.addEventListener('mousedown', this._onResizeStart)

    this.dom = wrap
    this._alive = true
    this._loadImage()
  }

  _applyWidth(el, width) {
    if (width && Number.isFinite(Number(width))) {
      el.style.width = `${Math.max(10, Math.min(100, Number(width)))}%`
    } else {
      el.style.width = ''
    }
  }

  _getMediaAttrs() {
    const m = this.node.firstChild
    return m?.attrs || null
  }

  _onResizeStart = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const wrapRect = this.dom.getBoundingClientRect()
    const startWidth = wrapRect.width
    const parent = this.dom.parentElement
    const parentWidth = parent?.clientWidth || startWidth || 1
    let pendingPct = null

    document.body.classList.add('tt-media-resizing')

    const onMove = (ev) => {
      const dx = ev.clientX - startX
      const newWidth = Math.max(60, startWidth + dx)
      pendingPct = Math.max(10, Math.min(100, (newWidth / parentWidth) * 100))
      this.dom.style.width = `${pendingPct}%`
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('tt-media-resizing')
      if (pendingPct == null) return
      const pos = typeof this.getPos === 'function' ? this.getPos() : null
      if (pos == null) return
      try {
        const tr = this.editor.view.state.tr.setNodeMarkup(pos, null, {
          ...this.node.attrs,
          width: Math.round(pendingPct),
        })
        this.editor.view.dispatch(tr)
      } catch (err) {
        console.warn('[tt-media] setNodeMarkup 실패:', err)
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  _loadImage() {
    const media = this._getMediaAttrs()
    if (!media) return
    const id = media.id
    const mountEl = this.editor.options.element
    const att = id ? mountEl?.__tt_attachments_by_id?.[id] : null
    this.img.alt = media.alt || att?.filename || ''

    // 1) paste 직후엔 로컬 파일의 임시 blob URL이 있을 수 있음 — 즉시 표시
    const tempUrl = id ? mountEl?.__tt_temp_blob_urls?.[id] : null
    if (tempUrl) {
      this.img.src = tempUrl
    }

    // 2) 서버 첨부의 contentUrl을 인증 프록시로 받아 교체
    const contentUrl = att?.contentUrl
    if (!contentUrl) return

    this.img.classList.add('tt-media-loading')
    fetchAttachmentBlobUrl(contentUrl).then(blobUrl => {
      if (!this._alive) return
      if (blobUrl) {
        this.img.src = blobUrl
        if (mountEl) {
          if (!mountEl.__tt_owned_blob_urls) mountEl.__tt_owned_blob_urls = []
          mountEl.__tt_owned_blob_urls.push(blobUrl)
        }
      } else {
        this.img.classList.add('tt-media-error')
        this.img.alt = '(이미지 로드 실패)'
      }
      this.img.classList.remove('tt-media-loading')
    }).catch(err => {
      console.warn('[tt-media] 이미지 로드 실패:', err)
      if (!this._alive) return
      this.img.classList.add('tt-media-error')
      this.img.classList.remove('tt-media-loading')
    })
  }

  // ---- NodeView 필수 메서드 ----
  update(node) {
    if (node.type !== this.node.type) return false
    const widthChanged = node.attrs.width !== this.node.attrs.width
    const mediaChanged = node.firstChild?.attrs?.id !== this.node.firstChild?.attrs?.id
    this.node = node
    if (widthChanged) this._applyWidth(this.dom, node.attrs.width)
    if (mediaChanged) this._loadImage()
    return true
  }

  selectNode() { this.dom.classList.add('tt-media-selected') }
  deselectNode() { this.dom.classList.remove('tt-media-selected') }
  stopEvent(event) {
    // 리사이즈 핸들 위의 mousedown은 NodeView가 직접 처리
    return event.target === this.handle
  }
  ignoreMutation() { return true }

  destroy() {
    this._alive = false
    this.handle.removeEventListener('mousedown', this._onResizeStart)
  }
}

// ---------- Paste/Drop 플러그인 ----------
// 클립보드/드롭 이미지를 가로채 onImagePaste 후크로 위임.
// onImagePaste 미설정이면 이미지를 무시한다 (예: 새 이슈 모달).
export const MediaPaste = Extension.create({
  name: 'mediaPaste',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: new PluginKey('tt-media-paste'),
        props: {
          handlePaste(view, event) {
            const items = event.clipboardData?.items || []
            const files = []
            for (const it of items) {
              if (it.kind === 'file' && (it.type || '').startsWith('image/')) {
                const f = it.getAsFile()
                if (f) files.push(f)
              }
            }
            if (files.length === 0) return false
            // 핸들러가 없으면 기본 paste 동작에 맡김 (텍스트 등)
            if (typeof editor.options.element?.__tt_on_image_paste !== 'function') return false
            event.preventDefault()
            handleImageFiles(editor, view, files)
            return true
          },
          handleDOMEvents: {
            drop(view, event) {
              const dt = event.dataTransfer
              if (!dt || !dt.files || dt.files.length === 0) return false
              const files = []
              for (const f of dt.files) {
                if ((f.type || '').startsWith('image/')) files.push(f)
              }
              if (files.length === 0) return false
              if (typeof editor.options.element?.__tt_on_image_paste !== 'function') return false
              event.preventDefault()
              handleImageFiles(editor, view, files)
              return true
            },
          },
        },
      }),
    ]
  },
})

async function handleImageFiles(editor, view, files) {
  const mountEl = editor.options.element
  const onImagePaste = mountEl?.__tt_on_image_paste
  const onError = mountEl?.__tt_on_upload_error
  if (typeof onImagePaste !== 'function') {
    if (typeof onError === 'function') {
      onError(new Error('이미지를 붙여넣을 수 없는 상태입니다.'))
    }
    return
  }

  for (const file of files) {
    // 1) 임시 blob URL — 업로드 동안 즉시 표시
    let tempUrl = null
    try { tempUrl = URL.createObjectURL(file) } catch {}

    let uploaded = null
    try {
      uploaded = await onImagePaste(file)
    } catch (err) {
      console.warn('[tt-media] 업로드 실패:', err)
      if (typeof onError === 'function') onError(err)
      if (tempUrl) { try { URL.revokeObjectURL(tempUrl) } catch {} }
      continue
    }
    if (!uploaded || !uploaded.id) {
      if (tempUrl) { try { URL.revokeObjectURL(tempUrl) } catch {} }
      continue
    }

    const id = String(uploaded.id)

    // 2) 마운트에 첨부 메타/임시 URL 기록
    if (!mountEl.__tt_attachments_by_id) mountEl.__tt_attachments_by_id = {}
    mountEl.__tt_attachments_by_id[id] = {
      contentUrl: uploaded.contentUrl || '',
      filename: uploaded.filename || '',
    }
    if (tempUrl) {
      if (!mountEl.__tt_temp_blob_urls) mountEl.__tt_temp_blob_urls = {}
      mountEl.__tt_temp_blob_urls[id] = tempUrl
      // 에디터 파괴 시 같이 revoke
      if (!mountEl.__tt_owned_blob_urls) mountEl.__tt_owned_blob_urls = []
      mountEl.__tt_owned_blob_urls.push(tempUrl)
    }

    // 3) 픽셀 사이즈 측정 (선택)
    const dims = await loadImageDims(tempUrl || uploaded.contentUrl).catch(() => ({ w: null, h: null }))

    // 4) mediaSingle > media 삽입 (insertContent가 단락 분할/래핑을 자동 처리)
    try {
      editor.chain().focus().insertContent({
        type: 'mediaSingle',
        attrs: { layout: 'center' },
        content: [{
          type: 'media',
          attrs: {
            id,
            type: 'file',
            collection: '',
            width: dims.w || null,
            height: dims.h || null,
            alt: uploaded.filename || '',
          },
        }],
      }).run()
    } catch (err) {
      console.warn('[tt-media] 노드 삽입 실패:', err)
    }
  }
}

function loadImageDims(url) {
  return new Promise(resolve => {
    if (!url) return resolve({ w: null, h: null })
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth || null, h: img.naturalHeight || null })
    img.onerror = () => resolve({ w: null, h: null })
    img.src = url
  })
}

// ---------- 외부에서 사용하는 헬퍼 ----------
// 마운트에 첨부 메타를 미리 주입 (편집 진입 시 호출)
export function setMountAttachments(mountEl, attachments) {
  if (!mountEl) return
  const map = {}
  for (const a of attachments || []) {
    if (!a?.id) continue
    map[String(a.id)] = { contentUrl: a.contentUrl || '', filename: a.filename || '' }
  }
  mountEl.__tt_attachments_by_id = map
}

// 에디터 파괴 시 같이 호출해 blob URL 일괄 해제
export function releaseMountBlobUrls(mountEl) {
  if (!mountEl) return
  for (const url of mountEl.__tt_owned_blob_urls || []) {
    try { URL.revokeObjectURL(url) } catch {}
  }
  mountEl.__tt_owned_blob_urls = null
  mountEl.__tt_temp_blob_urls = null
}
