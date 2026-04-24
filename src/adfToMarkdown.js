// ADF → Markdown 변환. 편집용으로 본문을 텍스트로 펼친다.
// 완전 round-trip은 불가능: panel/mention/status/media 등 ADF 고유 요소는
// 손실될 수 있으며 detectLossyFeatures로 사전 감지해 경고한다.

const LOSSY_NODES = new Set([
  'panel', 'mention', 'status', 'date', 'emoji',
  'inlineCard', 'blockCard',
  'mediaSingle', 'mediaGroup', 'media',
  'taskList', 'taskItem',
  'decisionList', 'decisionItem',
  'expand', 'nestedExpand',
  'extension', 'bodiedExtension', 'inlineExtension',
])

const LOSSY_MARKS = new Set(['subsup', 'textColor', 'backgroundColor', 'underline'])

export function adfToMarkdown(adf) {
  if (!adf || adf.type !== 'doc') return ''
  return renderBlocks(adf.content || []).replace(/\n{3,}/g, '\n\n').trim()
}

// ADF 트리 안에서 Markdown으로 표현 못 하는 노드/마크 목록 반환
export function detectLossyFeatures(adf) {
  const found = new Set()
  walk(adf, node => {
    if (LOSSY_NODES.has(node.type)) found.add(node.type)
    if (Array.isArray(node.marks)) {
      for (const m of node.marks) {
        if (LOSSY_MARKS.has(m.type)) found.add(m.type)
      }
    }
  })
  return Array.from(found)
}

function walk(node, cb) {
  if (!node) return
  cb(node)
  if (Array.isArray(node.content)) {
    for (const c of node.content) walk(c, cb)
  }
}

function renderBlocks(nodes) {
  const out = []
  for (const n of nodes) {
    const s = renderBlock(n)
    if (s !== null && s !== '') out.push(s)
  }
  return out.join('\n\n')
}

function renderBlock(node) {
  if (!node) return null
  switch (node.type) {
    case 'paragraph':
      return renderInline(node.content || [])
    case 'heading': {
      const level = Math.min(6, Math.max(1, node.attrs?.level || 3))
      return `${'#'.repeat(level)} ${renderInline(node.content || [])}`
    }
    case 'bulletList':
      return renderList(node.content || [], false, 0)
    case 'orderedList':
      return renderList(node.content || [], true, 0)
    case 'blockquote': {
      const inner = renderBlocks(node.content || [])
      return inner.split('\n').map(l => l ? `> ${l}` : '>').join('\n')
    }
    case 'codeBlock': {
      const lang = node.attrs?.language || ''
      const text = (node.content || []).map(c => c.text || '').join('')
      return '```' + lang + '\n' + text + '\n```'
    }
    case 'rule':
      return '---'
    case 'table':
      return renderTable(node)
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
    case 'panel':
    case 'expand':
    case 'nestedExpand':
      return null  // lossy: 사전에 감지하여 경고
    default:
      // 모르는 블록은 inline이 있으면 렌더, 없으면 스킵
      if (Array.isArray(node.content)) {
        return renderBlocks(node.content)
      }
      return null
  }
}

function renderList(items, ordered, depth) {
  const indent = '  '.repeat(depth)
  const out = []
  items.forEach((item, idx) => {
    if (item.type !== 'listItem') return
    const marker = ordered ? `${idx + 1}.` : '-'
    const blocks = []
    const nestedLists = []
    for (const c of (item.content || [])) {
      if (c.type === 'bulletList' || c.type === 'orderedList') {
        nestedLists.push(c)
      } else {
        const rendered = renderBlock(c)
        if (rendered !== null) blocks.push(rendered)
      }
    }
    const firstLine = blocks.join('\n\n').split('\n')
    const head = firstLine.shift() || ''
    out.push(`${indent}${marker} ${head}`)
    for (const line of firstLine) {
      out.push(`${indent}  ${line}`)
    }
    for (const nested of nestedLists) {
      out.push(renderList(nested.content || [], nested.type === 'orderedList', depth + 1))
    }
  })
  return out.join('\n')
}

function renderTable(node) {
  const rows = (node.content || []).filter(r => r.type === 'tableRow')
  if (rows.length === 0) return ''
  // 첫 row에 tableHeader가 있으면 헤더, 아니면 모든 row를 본문 취급 + 빈 헤더 생성
  const firstCells = rows[0].content || []
  const hasHeader = firstCells.some(c => c.type === 'tableHeader')
  const headerRow = hasHeader ? rows[0] : null
  const bodyRows = hasHeader ? rows.slice(1) : rows

  const flattenCell = (cell) => {
    const inlines = []
    for (const c of (cell.content || [])) {
      if (c.type === 'paragraph') inlines.push(...(c.content || []))
    }
    return renderInline(inlines).replace(/\|/g, '\\|').replace(/\n/g, ' ')
  }

  const headerCells = headerRow
    ? (headerRow.content || []).map(flattenCell)
    : (firstCells.map(() => ''))
  const colCount = headerCells.length
  const lines = [
    '| ' + headerCells.join(' | ') + ' |',
    '| ' + Array(colCount).fill('---').join(' | ') + ' |',
  ]
  for (const row of bodyRows) {
    const cells = (row.content || []).map(flattenCell)
    // 열 수를 헤더에 맞춤
    while (cells.length < colCount) cells.push('')
    lines.push('| ' + cells.slice(0, colCount).join(' | ') + ' |')
  }
  return lines.join('\n')
}

function renderInline(nodes) {
  return nodes.map(renderInlineNode).join('')
}

function renderInlineNode(node) {
  if (!node) return ''
  if (node.type === 'text') {
    let text = escapeMdText(node.text || '')
    if (Array.isArray(node.marks)) {
      // code mark이 있으면 escape 대신 원본 그대로 backtick으로 감쌈
      const hasCode = node.marks.some(m => m.type === 'code')
      if (hasCode) text = node.text || ''
      for (const mark of node.marks) {
        text = applyMark(text, mark)
      }
    }
    return text
  }
  if (node.type === 'hardBreak') return '  \n'
  // mediaInline, mention 등: lossy (빈 문자열)
  return ''
}

function escapeMdText(text) {
  return text.replace(/([\\`*_\[\]()~])/g, '\\$1')
}

function applyMark(text, mark) {
  switch (mark.type) {
    case 'strong': return `**${text}**`
    case 'em':     return `*${text}*`
    case 'strike': return `~~${text}~~`
    case 'code':   return `\`${text}\``
    case 'link': {
      const href = (mark.attrs?.href || '').replace(/\)/g, '\\)')
      return `[${text}](${href})`
    }
    default: return text
  }
}
