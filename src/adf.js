// Atlassian Document Format(ADF) → HTML 렌더러
// Jira Cloud 설명 본문은 ADF JSON 구조. 서버의 renderedFields가
// 구식 위키 마크업 잔재를 깨뜨려 출력하므로 클라이언트에서 직접 변환한다.

import { escapeHtml } from './utils.js'

// node: ADF 노드 (doc 또는 하위 노드)
// ctx: { attachmentsById: { [id]: { contentUrl, filename, ... } } }
export function renderAdf(node, ctx = {}) {
  if (!node) return ''

  // 루트가 doc이면 content 재귀
  if (node.type === 'doc') {
    return renderChildren(node.content, ctx)
  }

  return renderNode(node, ctx)
}

function renderChildren(content, ctx) {
  if (!Array.isArray(content)) return ''
  return content.map(n => renderNode(n, ctx)).join('')
}

function renderNode(node, ctx) {
  if (!node) return ''
  const { type, content, text, marks, attrs } = node

  // 텍스트 노드: marks(bold/italic/code/link 등) 적용
  if (type === 'text') {
    let html = escapeHtml(text || '')
    if (Array.isArray(marks)) {
      for (const mark of marks) html = applyMark(html, mark)
    }
    return html
  }

  const children = () => renderChildren(content, ctx)

  switch (type) {
    case 'paragraph':
      return `<p>${children()}</p>`

    case 'heading': {
      const level = Math.min(6, Math.max(1, attrs?.level || 3))
      return `<h${level}>${children()}</h${level}>`
    }

    case 'bulletList':
      return `<ul>${children()}</ul>`

    case 'orderedList':
      return `<ol>${children()}</ol>`

    case 'listItem':
      return `<li>${children()}</li>`

    case 'codeBlock': {
      const lang = attrs?.language ? ` data-lang="${escapeHtml(attrs.language)}"` : ''
      return `<pre${lang}><code>${children()}</code></pre>`
    }

    case 'blockquote':
      return `<blockquote>${children()}</blockquote>`

    case 'rule':
      return `<hr />`

    case 'hardBreak':
      return `<br />`

    case 'table':
      return `<table class="adf-table"><tbody>${children()}</tbody></table>`

    case 'tableRow':
      return `<tr>${children()}</tr>`

    case 'tableHeader': {
      const colspan = attrs?.colspan && attrs.colspan > 1 ? ` colspan="${attrs.colspan}"` : ''
      const rowspan = attrs?.rowspan && attrs.rowspan > 1 ? ` rowspan="${attrs.rowspan}"` : ''
      return `<th${colspan}${rowspan}>${children()}</th>`
    }

    case 'tableCell': {
      const colspan = attrs?.colspan && attrs.colspan > 1 ? ` colspan="${attrs.colspan}"` : ''
      const rowspan = attrs?.rowspan && attrs.rowspan > 1 ? ` rowspan="${attrs.rowspan}"` : ''
      return `<td${colspan}${rowspan}>${children()}</td>`
    }

    case 'panel': {
      const panelType = attrs?.panelType || 'info'
      return `<div class="adf-panel adf-panel-${escapeHtml(panelType)}">${children()}</div>`
    }

    case 'expand':
    case 'nestedExpand': {
      const title = escapeHtml(attrs?.title || '펼치기')
      return `<details class="adf-expand"><summary>${title}</summary>${children()}</details>`
    }

    case 'mediaSingle': {
      // 편집 모드(Tiptap)와 같은 블록 레이아웃을 보기 모드에도 적용 — Jira에서 보이는 모양과 일치
      const layout = attrs?.layout || 'center'
      const w = Number(attrs?.width)
      const widthStyle = (Number.isFinite(w) && w > 0 && w <= 100)
        ? ` style="width:${w}%"` : ''
      return `<div class="adf-media-single" data-layout="${escapeHtml(layout)}"${widthStyle}>${children()}</div>`
    }

    case 'mediaGroup':
      return `<div class="adf-media-group">${children()}</div>`

    case 'media': {
      const id = attrs?.id || ''
      const altAttr = attrs?.alt || ''
      // 1) attrs.id 매칭 (Jira 내부 ADF가 attachment id를 그대로 박은 경우)
      // 2) 폴백: attrs.alt(파일명) 매칭 — 옛 이슈는 attrs.id가 Media Services UUID라
      //    첨부의 numeric id와 안 맞음. 첨부 파일명이 alt와 일치하면 그쪽으로 매칭.
      const att =
        ctx.attachmentsById?.[id] ||
        (altAttr ? ctx.attachmentsByFilename?.[altAttr] : null)
      const contentUrl = att?.contentUrl || ''
      const alt = escapeHtml(att?.filename || altAttr)

      // 동영상은 <img>로 그리면 파일명(alt)과 빈 영역만 남는다 — 인라인 플레이어로 렌더.
      // src는 비워두고, 표지를 누른 시점에 detail.js가 Blob URL을 물린다.
      if (isVideoAttachment(att, altAttr)) {
        return renderVideoPlayer({
          url: contentUrl,
          filename: att?.filename || altAttr,
          width: attrs?.width,
          height: attrs?.height,
        })
      }
      // attrs.width/height(px)가 있으면 속성으로 출력 — blob 로딩 전에도 브라우저가
      // aspect-ratio로 공간을 예약해, 재렌더 시 높이 붕괴로 스크롤 복원이 깨지지 않게 함
      const mw = Number(attrs?.width)
      const mh = Number(attrs?.height)
      const dimAttrs = (Number.isFinite(mw) && mw > 0 && Number.isFinite(mh) && mh > 0)
        ? ` width="${Math.round(mw)}" height="${Math.round(mh)}"`
        : ''
      // src는 이후 이벤트 레이어에서 Blob URL로 교체됨
      return `<img data-adf-media-url="${escapeHtml(contentUrl)}" alt="${alt}"${dimAttrs} />`
    }

    case 'inlineCard':
    case 'blockCard': {
      const url = attrs?.url || ''
      const safe = escapeHtml(url)
      const cls = type === 'blockCard' ? 'adf-card adf-card-block' : 'adf-card'
      // data-adf-card-url: 상세 모달 렌더 후 detail.js가 같은 사이트 이슈면 리치 카드로 교체
      return `<a class="${cls}" data-adf-card-url="${safe}" href="${safe}" target="_blank" rel="noopener noreferrer">${safe || '스마트 링크'}</a>`
    }

    case 'emoji':
      return escapeHtml(attrs?.text || attrs?.shortName || '')

    case 'mention':
      return `<span class="adf-mention">@${escapeHtml(attrs?.text || '')}</span>`

    case 'date': {
      const ts = Number(attrs?.timestamp)
      if (!ts) return ''
      const d = new Date(ts)
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      return `<span class="adf-date">${iso}</span>`
    }

    case 'status': {
      const color = escapeHtml(attrs?.color || 'neutral')
      return `<span class="adf-status adf-status-${color}">${escapeHtml(attrs?.text || '')}</span>`
    }

    case 'taskList':
      return `<ul class="adf-tasklist">${children()}</ul>`

    case 'taskItem': {
      const checked = attrs?.state === 'DONE' ? ' checked' : ''
      return `<li class="adf-taskitem"><input type="checkbox" disabled${checked} /> ${children()}</li>`
    }

    case 'decisionList':
      return `<ul class="adf-decisionlist">${children()}</ul>`

    case 'decisionItem':
      return `<li class="adf-decisionitem">${children()}</li>`

    default:
      // 모르는 노드는 children만 렌더 (빈 래퍼로 통과)
      return children()
  }
}

// 브라우저 <video>로 열어볼 만한 확장자. mimeType이 비어 있거나
// application/octet-stream으로 올라온 첨부를 위한 폴백 판별용.
const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|ogv|ogg|avi|mkv|wmv|flv|mpe?g|3gp)$/i

// 첨부(또는 파일명)가 동영상인지. mimeType이 명확하면 그걸 우선 신뢰한다.
export function isVideoAttachment(att, filenameFallback = '') {
  const mime = (att?.mimeType || '').toLowerCase()
  if (mime.startsWith('video/')) return true
  if (mime.startsWith('image/') || mime.startsWith('audio/')) return false
  return VIDEO_EXT_RE.test(att?.filename || filenameFallback || '')
}

// 동영상 인라인 플레이어 마크업. 본문 ADF media와 첨부 목록 플레이어가 함께 쓴다.
// video[src]는 비워둔 채 표지 버튼만 올려두고, 실제 로드는 detail.js가 담당한다
// (영상은 수십 MB라 상세를 열자마자 통째로 받으면 낭비).
export function renderVideoPlayer({ url, filename, width, height, autoplay = false } = {}) {
  const name = escapeHtml(filename || '동영상')
  if (!url) {
    return `<div class="adf-video adf-video-missing">🎬 ${name} <span>(원본을 찾지 못했습니다)</span></div>`
  }
  // ADF media의 width/height(px)가 있으면 그 비율로 자리를 잡아 로드 후 높이가 튀지 않게 함.
  // max-width는 높이 상한(60vh)에서 역산 — 세로 영상이 가로로 넓은 검은 박스가 되지 않도록.
  const w = Number(width)
  const h = Number(height)
  const ratioStyle = (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0)
    ? ` style="aspect-ratio:${Math.round(w)}/${Math.round(h)};max-width:min(100%, calc(60vh * ${Math.round(w)} / ${Math.round(h)}))"`
    : ''
  return `<div class="adf-video" data-adf-video-url="${escapeHtml(url)}" data-filename="${name}"${autoplay ? ' data-autoplay="1"' : ''}${ratioStyle}>` +
    `<video class="adf-video-el" controls preload="none" playsinline></video>` +
    `<button type="button" class="adf-video-cover" aria-label="${name} 재생">` +
      `<span class="adf-video-cover-icon">▶</span>` +
      `<span class="adf-video-cover-name">${name}</span>` +
    `</button>` +
  `</div>`
}

function applyMark(html, mark) {
  if (!mark || !mark.type) return html
  switch (mark.type) {
    case 'strong':
      return `<strong>${html}</strong>`
    case 'em':
      return `<em>${html}</em>`
    case 'strike':
      return `<del>${html}</del>`
    case 'underline':
      return `<u>${html}</u>`
    case 'code':
      return `<code>${html}</code>`
    case 'link': {
      const href = escapeHtml(mark.attrs?.href || '')
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${html}</a>`
    }
    case 'subsup':
      return mark.attrs?.type === 'sup' ? `<sup>${html}</sup>` : `<sub>${html}</sub>`
    case 'textColor': {
      const color = mark.attrs?.color
      if (!color || !/^#[0-9a-fA-F]{3,8}$/.test(color)) return html
      return `<span style="color:${color}">${html}</span>`
    }
    case 'backgroundColor': {
      const color = mark.attrs?.color
      if (!color || !/^#[0-9a-fA-F]{3,8}$/.test(color)) return html
      return `<span style="background-color:${color}">${html}</span>`
    }
    default:
      return html
  }
}

// ========== plain text ↔ ADF 변환 (댓글용 단순 변환) ==========
// 빈 줄(\n\n+)을 paragraph 경계로, 줄바꿈은 hardBreak로.
// 멘션/링크/이미지 등 풍부한 마크는 보존 못함 — 단순 댓글 작성/편집 용도.
export function textToAdf(text) {
  const trimmed = (text || '').replace(/\r\n/g, '\n').trim()
  if (!trimmed) return null
  const blocks = trimmed.split(/\n{2,}/)
  const paragraphs = blocks.map(block => {
    const lines = block.split('\n')
    const content = []
    lines.forEach((line, i) => {
      if (i > 0) content.push({ type: 'hardBreak' })
      if (line.length > 0) content.push({ type: 'text', text: line })
    })
    return { type: 'paragraph', content }
  })
  return { version: 1, type: 'doc', content: paragraphs }
}

// ADF → 보수적 plain text 추출. 편집 시 textarea 초기값으로 사용.
export function adfToText(node) {
  if (!node) return ''
  return _adfToText(node).replace(/\n{3,}/g, '\n\n').trim()
}

function _adfToText(node) {
  if (!node) return ''
  if (node.type === 'text') return node.text || ''
  if (node.type === 'hardBreak') return '\n'
  const child = (node.content || []).map(_adfToText).join('')
  switch (node.type) {
    case 'doc': return child
    case 'paragraph':
    case 'heading':
    case 'blockquote':
    case 'codeBlock':
      return child + '\n\n'
    case 'bulletList':
    case 'orderedList':
      return child
    case 'listItem':
      return '• ' + child.trim() + '\n'
    case 'rule':
      return '\n---\n'
    default:
      return child
  }
}
