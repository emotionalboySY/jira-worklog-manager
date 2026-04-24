// Markdown → ADF 변환. marked 라이브러리의 lexer로 토큰 트리를 얻은 뒤
// ADF 노드로 매핑. 편집 모드에서 저장 시 호출.

import { marked } from 'marked'

export function markdownToAdf(md) {
  const tokens = marked.lexer(md || '', { gfm: true })
  const content = []
  for (const t of tokens) {
    const node = convertBlock(t)
    if (node) {
      if (Array.isArray(node)) content.push(...node)
      else content.push(node)
    }
  }
  // Jira 요구사항: description이 null이거나 content 배열이 최소 있어야 함
  return {
    type: 'doc',
    version: 1,
    content,
  }
}

function convertBlock(token) {
  if (!token) return null
  switch (token.type) {
    case 'space':
      return null
    case 'heading':
      return {
        type: 'heading',
        attrs: { level: Math.min(6, Math.max(1, token.depth)) },
        content: convertInline(token.tokens || [{ type: 'text', text: token.text }]),
      }
    case 'paragraph': {
      const inline = convertInline(token.tokens || [{ type: 'text', text: token.text }])
      if (inline.length === 0) return null
      return { type: 'paragraph', content: inline }
    }
    case 'blockquote':
      return {
        type: 'blockquote',
        content: (token.tokens || []).map(convertBlock).filter(Boolean).flat(),
      }
    case 'code': {
      const attrs = token.lang ? { language: token.lang } : {}
      const text = token.text || ''
      return {
        type: 'codeBlock',
        attrs,
        content: text ? [{ type: 'text', text }] : [],
      }
    }
    case 'hr':
      return { type: 'rule' }
    case 'list':
      return {
        type: token.ordered ? 'orderedList' : 'bulletList',
        content: (token.items || []).map(convertListItem).filter(Boolean),
      }
    case 'table':
      return convertTable(token)
    case 'html':
      // HTML 블록은 텍스트 노드로 평탄화 (손실 경고 대상)
      return {
        type: 'paragraph',
        content: [{ type: 'text', text: (token.text || '').trim() }],
      }
    default:
      return null
  }
}

function convertListItem(item) {
  const content = []
  // marked의 listItem.tokens는 블록 토큰 또는 text 토큰 등 여러 형태
  const inlineAccum = []
  const flushInline = () => {
    if (inlineAccum.length > 0) {
      const nodes = convertInline(inlineAccum)
      if (nodes.length > 0) content.push({ type: 'paragraph', content: nodes })
      inlineAccum.length = 0
    }
  }

  for (const t of (item.tokens || [])) {
    if (t.type === 'text') {
      // text 토큰은 nested tokens(inline)를 가질 수 있음
      if (Array.isArray(t.tokens) && t.tokens.length > 0) {
        inlineAccum.push(...t.tokens)
      } else {
        inlineAccum.push({ type: 'text', raw: t.text, text: t.text })
      }
    } else if (t.type === 'list' || t.type === 'blockquote' || t.type === 'code' ||
               t.type === 'heading' || t.type === 'paragraph' || t.type === 'hr' ||
               t.type === 'table') {
      flushInline()
      const node = convertBlock(t)
      if (node) {
        if (Array.isArray(node)) content.push(...node)
        else content.push(node)
      }
    } else {
      // 기타 inline 성격은 누적
      inlineAccum.push(t)
    }
  }
  flushInline()

  // ADF 스펙: listItem은 비어있을 수 없음. 최소 빈 paragraph라도 넣음
  if (content.length === 0) {
    content.push({ type: 'paragraph', content: [] })
  }
  return { type: 'listItem', content }
}

function convertTable(token) {
  const rows = []
  const header = token.header || []
  const headerCells = header.map(h => ({
    type: 'tableHeader',
    content: [{ type: 'paragraph', content: convertInline(h.tokens || [{ type: 'text', text: h.text }]) }],
  }))
  if (headerCells.length > 0) {
    rows.push({ type: 'tableRow', content: headerCells })
  }
  for (const row of (token.rows || [])) {
    const cells = (row || []).map(c => ({
      type: 'tableCell',
      content: [{ type: 'paragraph', content: convertInline(c.tokens || [{ type: 'text', text: c.text }]) }],
    }))
    rows.push({ type: 'tableRow', content: cells })
  }
  return { type: 'table', content: rows }
}

// 인라인 토큰 배열 → ADF 텍스트 노드 배열
function convertInline(tokens, activeMarks = []) {
  const out = []
  for (const t of tokens) {
    pushInline(t, out, activeMarks)
  }
  return out
}

function pushInline(token, out, activeMarks) {
  if (!token) return
  switch (token.type) {
    case 'text': {
      const text = unescapeMd(token.text || '')
      if (!text) return
      const marks = activeMarks.length ? activeMarks.map(m => ({ ...m })) : undefined
      // Atlaskit 스펙: text 노드는 같은 marks일 때 이어붙여도 되나 단순화를 위해 그대로 push
      out.push(marks ? { type: 'text', text, marks } : { type: 'text', text })
      return
    }
    case 'escape': {
      const text = token.text || ''
      const marks = activeMarks.length ? activeMarks.map(m => ({ ...m })) : undefined
      out.push(marks ? { type: 'text', text, marks } : { type: 'text', text })
      return
    }
    case 'strong':
      convertInline(token.tokens || [{ type: 'text', text: token.text }], [...activeMarks, { type: 'strong' }])
        .forEach(n => out.push(n))
      return
    case 'em':
      convertInline(token.tokens || [{ type: 'text', text: token.text }], [...activeMarks, { type: 'em' }])
        .forEach(n => out.push(n))
      return
    case 'del':
      convertInline(token.tokens || [{ type: 'text', text: token.text }], [...activeMarks, { type: 'strike' }])
        .forEach(n => out.push(n))
      return
    case 'codespan': {
      const text = token.text || ''
      if (!text) return
      const marks = [...activeMarks, { type: 'code' }]
      out.push({ type: 'text', text, marks })
      return
    }
    case 'link': {
      const href = token.href || ''
      const linkMark = { type: 'link', attrs: { href } }
      convertInline(token.tokens || [{ type: 'text', text: token.text }], [...activeMarks, linkMark])
        .forEach(n => out.push(n))
      return
    }
    case 'image': {
      // 이미지 업로드는 미지원. alt 텍스트만 남김
      const text = `[이미지: ${token.text || token.title || token.href || ''}]`
      out.push({ type: 'text', text })
      return
    }
    case 'br':
      out.push({ type: 'hardBreak' })
      return
    case 'html': {
      // 인라인 HTML은 평탄화
      const text = (token.text || '').replace(/<[^>]+>/g, '')
      if (text) out.push({ type: 'text', text, marks: activeMarks.length ? activeMarks.map(m => ({ ...m })) : undefined })
      return
    }
    default:
      // 모르는 inline은 text로 폴백
      if (token.text) {
        out.push({ type: 'text', text: token.text })
      }
  }
}

function unescapeMd(text) {
  // marked가 이미 처리하지만 잔여 \x 해제
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}
