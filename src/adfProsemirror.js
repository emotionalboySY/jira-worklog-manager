// ADF ↔ ProseMirror(tiptap) JSON 상호 변환
// 두 포맷이 거의 동일한 ProseMirror 스키마라 대부분의 노드는 type만 매핑하면 충분.
// 지원하지 않는 노드(panel/mention/status/media 등)는 편집 시 경고하고 평탄화/제거된다.

const ADF_TO_PM_NODE = {
  rule: 'horizontalRule',
}

const PM_TO_ADF_NODE = {
  horizontalRule: 'rule',
}

// mark 이름: ADF는 strong/em, tiptap은 bold/italic 사용
const ADF_TO_PM_MARK = {
  strong: 'bold',
  em: 'italic',
}

const PM_TO_ADF_MARK = {
  bold: 'strong',
  italic: 'em',
}

// ADF 중 Markdown/tiptap MVP로 표현 못 하는 요소 (경고 대상)
// mediaSingle/media는 커스텀 노드로 지원하므로 손실 대상에서 제외.
// mediaGroup은 여전히 미지원 — 다중 인라인 이미지는 평탄화된다.
const LOSSY_NODES = new Set([
  'panel', 'mention', 'status', 'date', 'emoji',
  'inlineCard', 'blockCard',
  'mediaGroup',
  'taskList', 'taskItem',
  'decisionList', 'decisionItem',
  'expand', 'nestedExpand',
  'extension', 'bodiedExtension', 'inlineExtension',
])
const LOSSY_MARKS = new Set(['subsup', 'textColor', 'backgroundColor', 'underline'])

// tiptap(StarterKit)이 인식하는 mark 목록. 이 외의 mark는 알 수 없는 타입으로 판단하여 제거.
const SUPPORTED_PM_MARKS = new Set(['bold', 'italic', 'strike', 'code', 'link'])

// ADF 스키마에서 각 노드/마크가 허용하는 attr 화이트리스트
// 이외의 attr는 Jira가 INVALID_INPUT으로 거부할 수 있으므로 제거
// null/빈 배열은 "attrs 자체 허용 안 됨" → 전부 제거
const ADF_NODE_ATTRS = {
  paragraph: [],
  heading: ['level'],
  bulletList: [],
  orderedList: ['order'],
  listItem: [],
  codeBlock: ['language'],
  blockquote: [],
  rule: [],
  hardBreak: [],
  text: [],
  table: ['isNumberColumnEnabled', 'layout', 'localId', 'width', 'displayMode'],
  tableRow: [],
  tableCell: ['colspan', 'rowspan', 'colwidth', 'background'],
  tableHeader: ['colspan', 'rowspan', 'colwidth', 'background'],
  // 이미지 노드. mediaSingle.width는 % (레이아웃), media.width/height는 픽셀
  mediaSingle: ['layout', 'width'],
  media: ['id', 'type', 'collection', 'width', 'height', 'alt'],
  // 업로드 중 자리표시자 — 에디터 내부 전용. Jira 저장 직전 stripUploadPlaceholders로 제거.
  mediaPlaceholder: ['uploadId', 'previewUrl', 'filename'],
}

const ADF_MARK_ATTRS = {
  strong: [],
  em: [],
  strike: [],
  code: [],
  link: ['href', 'title', 'id', 'collection', 'occurrenceKey'],
}

// ADF → ProseMirror(tiptap) 호환 JSON
export function adfToPm(adf) {
  if (!adf) return emptyPmDoc()
  const result = transform(adf, ADF_TO_PM_NODE, ADF_TO_PM_MARK, stripLossyForPm)
  // ProseMirror doc 루트는 version 없이 type="doc"
  if (result && result.type === 'doc') delete result.version
  return result || emptyPmDoc()
}

// ProseMirror(tiptap) JSON → ADF
export function pmToAdf(pm) {
  if (!pm) return emptyAdfDoc()
  const result = transform(pm, PM_TO_ADF_NODE, PM_TO_ADF_MARK, null)
  if (result && result.type === 'doc') result.version = 1
  return sanitizeAdfAttrs(result)
}

// ADF 노드/마크의 attrs를 허용된 키만 남기도록 정리 (tiptap이 추가한 불필요 attr 제거)
function sanitizeAdfAttrs(node) {
  if (!node || typeof node !== 'object') return node

  // attrs 정리
  if (node.attrs) {
    const allowed = ADF_NODE_ATTRS[node.type]
    if (allowed) {
      const cleaned = {}
      for (const key of allowed) {
        const v = node.attrs[key]
        if (v !== undefined && v !== null) cleaned[key] = v
      }
      if (Object.keys(cleaned).length > 0) node.attrs = cleaned
      else delete node.attrs
    }
    // 화이트리스트에 없는 type이면 attrs 원본 유지 (확장 노드 보호)
  }

  // marks 정리
  if (Array.isArray(node.marks)) {
    node.marks = node.marks.map(m => {
      if (!m || !m.attrs) return m
      const allowed = ADF_MARK_ATTRS[m.type]
      if (!allowed) return m
      const cleaned = {}
      for (const key of allowed) {
        const v = m.attrs[key]
        if (v !== undefined && v !== null) cleaned[key] = v
      }
      const out = { type: m.type }
      if (Object.keys(cleaned).length > 0) out.attrs = cleaned
      return out
    })
    if (node.marks.length === 0) delete node.marks
  }

  // content 재귀
  if (Array.isArray(node.content)) {
    node.content.forEach(sanitizeAdfAttrs)
  }

  return node
}

// ADF 트리에서 손실 대상 노드/마크 수집
export function detectLossyFeatures(adf) {
  const found = new Set()
  walk(adf, node => {
    if (!node) return
    if (LOSSY_NODES.has(node.type)) found.add(node.type)
    if (Array.isArray(node.marks)) {
      for (const m of node.marks) {
        if (LOSSY_MARKS.has(m.type)) found.add(m.type)
      }
    }
  })
  return Array.from(found)
}

// ADF 트리에 업로드 중 자리표시자(mediaPlaceholder)가 남아 있는지
export function hasUploadPlaceholders(adf) {
  let found = false
  walk(adf, node => {
    if (!node || found) return
    if (node.type === 'mediaPlaceholder') found = true
  })
  return found
}

// Jira 저장 직전 호출: ADF 트리에서 자리표시자 노드만 제거하고 나머지는 보존
export function stripUploadPlaceholders(adf) {
  if (!adf) return adf
  function clean(node) {
    if (!node) return null
    if (node.type === 'mediaPlaceholder') return null
    if (!Array.isArray(node.content)) return node
    const out = { ...node, content: node.content.map(clean).filter(Boolean) }
    return out
  }
  return clean(adf)
}

// ADF doc이 사실상 비어있는지 (빈 paragraph만 있거나 content 없음)
export function isEmptyAdf(adf) {
  if (!adf || !Array.isArray(adf.content) || adf.content.length === 0) return true
  if (adf.content.length !== 1) return false
  const only = adf.content[0]
  if (only.type !== 'paragraph') return false
  return !only.content || only.content.length === 0
}

function walk(node, cb) {
  if (!node) return
  cb(node)
  if (Array.isArray(node.content)) {
    for (const c of node.content) walk(c, cb)
  }
}

// 재귀 변환: node type과 mark type 매핑 + 하위 노드 처리 + (선택) 손실 노드 평탄화
function transform(node, nodeMap, markMap, lossyHandler) {
  if (!node) return null

  // ADF → PM에서 손실 노드는 tiptap 스키마에 없음 → 텍스트로 평탄화
  if (lossyHandler && LOSSY_NODES.has(node.type)) {
    return lossyHandler(node)
  }

  const out = {}
  out.type = nodeMap[node.type] || node.type
  if (node.attrs && Object.keys(node.attrs).length > 0) {
    out.attrs = { ...node.attrs }
  }
  if (typeof node.text === 'string') out.text = node.text
  if (Array.isArray(node.marks)) {
    out.marks = node.marks
      .map(m => {
        if (lossyHandler && LOSSY_MARKS.has(m.type)) return null
        const mapped = markMap[m.type] || m.type
        // PM(tiptap) 방향이면 지원 mark만 허용 (ADF 방향은 그대로 통과)
        if (lossyHandler && !SUPPORTED_PM_MARKS.has(mapped)) return null
        return { type: mapped, ...(m.attrs ? { attrs: { ...m.attrs } } : {}) }
      })
      .filter(Boolean)
    if (out.marks.length === 0) delete out.marks
  }
  if (Array.isArray(node.content)) {
    const children = node.content.map(c => transform(c, nodeMap, markMap, lossyHandler)).filter(Boolean).flat()
    if (children.length > 0) out.content = children
  }
  return out
}

// 손실 노드를 텍스트로 평탄화 (에디터 파싱 실패 방지)
function stripLossyForPm(node) {
  const text = extractText(node)
  if (!text) return null
  return {
    type: 'paragraph',
    content: [{ type: 'text', text }],
  }
}

function extractText(node) {
  if (!node) return ''
  if (typeof node.text === 'string') return node.text
  if (Array.isArray(node.content)) {
    return node.content.map(extractText).join(' ').trim()
  }
  return ''
}

function emptyPmDoc() {
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

function emptyAdfDoc() {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph' }] }
}
