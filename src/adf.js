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

    case 'mediaSingle':
    case 'mediaGroup':
      return children()

    case 'media': {
      const id = attrs?.id || ''
      const att = ctx.attachmentsById?.[id]
      const contentUrl = att?.contentUrl || ''
      const alt = escapeHtml(att?.filename || attrs?.alt || '')
      // src는 이후 이벤트 레이어에서 Blob URL로 교체됨
      return `<img data-adf-media-url="${escapeHtml(contentUrl)}" alt="${alt}" />`
    }

    case 'inlineCard':
    case 'blockCard': {
      const url = attrs?.url || ''
      const safe = escapeHtml(url)
      return `<a class="adf-card" href="${safe}" target="_blank" rel="noopener noreferrer">${safe}</a>`
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
