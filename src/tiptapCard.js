// 이슈 설명/댓글 에디터의 스마트 링크(inlineCard/blockCard) 커스텀 노드.
// - Jira가 저장한 스마트 링크를 편집 중에도 유실 없이 보존한다 (예전엔 손실 대상이라 사라졌음).
// - 같은 사이트 이슈 링크면 NodeView가 fetchIssueMeta로 키/제목/상태를 받아 리치 카드로 표시.
// - 그 외 URL(Confluence/외부)은 링크 칩으로 보존 — 데이터 유실 없이 클릭 이동 가능.
//
// 새 스마트 링크를 만드는 기능은 아니다(카드 리졸브 서비스가 필요). 기존 카드 "보존 + 표시"가 목적.

import { Node } from '@tiptap/core'
import { fetchIssueMeta } from './jira.js'
import { extractJiraIssueKeyFromUrl, getStatusCss, getProjectFromKey } from './utils.js'

// ---------- inlineCard: 문단 안에 들어가는 인라인 카드 ----------
export const InlineCard = Node.create({
  name: 'inlineCard',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      url: { default: null },
      data: { default: null }, // JSON-LD(url 없는 카드) 라운드트립 보존용
    }
  },

  parseHTML() {
    return [{ tag: 'a[data-inline-card]' }]
  },

  renderHTML({ node }) {
    const url = node.attrs.url || ''
    return ['a', {
      'data-inline-card': '', href: url, class: 'tt-card tt-card-inline',
      target: '_blank', rel: 'noopener noreferrer',
    }, url || '스마트 링크']
  },

  addNodeView() {
    return (props) => new CardView(props, false)
  },
})

// ---------- blockCard: 블록 레벨 카드 ----------
export const BlockCard = Node.create({
  name: 'blockCard',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      url: { default: null },
      data: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-block-card]' }]
  },

  renderHTML({ node }) {
    const url = node.attrs.url || ''
    return ['div', { 'data-block-card': '', 'data-url': url, class: 'tt-card tt-card-block' }, url || '스마트 링크']
  },

  addNodeView() {
    return (props) => new CardView(props, true)
  },
})

// ---------- 공용 NodeView: 링크 칩 ↔ 이슈 리치 카드 ----------
class CardView {
  constructor({ node }, isBlock) {
    this.isBlock = isBlock
    this._name = node.type.name
    this._alive = true
    this._url = node.attrs.url || ''

    const el = document.createElement(isBlock ? 'div' : 'a')
    el.className = isBlock ? 'tt-card tt-card-block' : 'tt-card tt-card-inline'
    el.contentEditable = 'false'
    if (!isBlock && this._url) {
      el.href = this._url
      el.target = '_blank'
      el.rel = 'noopener noreferrer'
    }
    // Ctrl/⌘+클릭만 링크 열기, 일반 클릭은 노드 선택(삭제용)에 맡김
    el.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (this._url) {
          e.preventDefault(); e.stopPropagation()
          window.open(this._url, '_blank', 'noopener,noreferrer')
        }
        return
      }
      e.preventDefault()
    })
    this.dom = el

    this._render()
  }

  _render() {
    const url = this._url
    const key = url ? extractJiraIssueKeyFromUrl(url) : null
    if (key) {
      this._renderLoading(key)
      fetchIssueMeta(key).then(meta => {
        if (!this._alive) return
        if (meta) this._renderIssue(meta)
        else this._renderPlain(url)
      }).catch(() => { if (this._alive) this._renderPlain(url) })
    } else {
      this._renderPlain(url)
    }
  }

  _clear(...classes) {
    const el = this.dom
    el.textContent = ''
    el.classList.remove('tt-card-loading', 'tt-card-plain', 'tt-card-resolved')
    for (const c of classes) el.classList.add(c)
  }

  _renderLoading(key) {
    this._clear('tt-card-loading')
    const sp = document.createElement('span')
    sp.className = 'tt-card-spinner'
    this.dom.appendChild(sp)
    const label = document.createElement('span')
    label.className = 'tt-card-label'
    label.textContent = key
    this.dom.appendChild(label)
  }

  _renderIssue(meta) {
    this._clear('tt-card-resolved')
    const keyEl = document.createElement('span')
    keyEl.className = 'tt-card-key issue-key'
    keyEl.dataset.project = getProjectFromKey(meta.key)
    keyEl.textContent = meta.key
    this.dom.appendChild(keyEl)

    const sum = document.createElement('span')
    sum.className = 'tt-card-summary'
    sum.textContent = meta.summary || ''
    this.dom.appendChild(sum)

    if (meta.status) {
      const st = document.createElement('span')
      st.className = `tt-card-status issue-status ${getStatusCss(meta.statusCategory)}`
      st.textContent = meta.status
      this.dom.appendChild(st)
    }
    this.dom.title = `${meta.key} · ${meta.summary || ''}`
  }

  _renderPlain(url) {
    this._clear('tt-card-plain')
    const icon = document.createElement('span')
    icon.className = 'tt-card-icon'
    icon.textContent = '🔗'
    this.dom.appendChild(icon)
    const label = document.createElement('span')
    label.className = 'tt-card-label'
    label.textContent = (url || '').replace(/^https?:\/\//, '') || '스마트 링크'
    this.dom.appendChild(label)
    this.dom.title = url || ''
  }

  // ---- NodeView 필수 메서드 ----
  update(node) {
    if (node.type.name !== this._name) return false
    const nextUrl = node.attrs.url || ''
    if (nextUrl !== this._url) {
      this._url = nextUrl
      if (!this.isBlock) this.dom.href = nextUrl
      this._render()
    }
    return true
  }

  stopEvent() { return false }
  ignoreMutation() { return true }
  destroy() { this._alive = false }
}
