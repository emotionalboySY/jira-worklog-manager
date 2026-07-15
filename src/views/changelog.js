// 코너 플로팅 이슈 변경 알림 위젯 (즐겨찾기 버튼 위)
// 항상 보이는 종 버튼 + 열렸을 때 종 버튼 왼쪽에 뜨는 패널.
// 즐겨찾기 위젯(favorites.js)과 동일 방식(.corner-fab / .floating-panel), dim 없음, 상호 배타 토글.
import { state } from '../state.js'
import { getChangeLog, getUnreadChangeCount } from '../issueChanges.js'
import { escapeHtml, renderIssueKeyLink, getProjectFromKey, josaRo } from '../utils.js'

const BELL_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
const CLOSE_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>'

// 섹션 전체 = 종 버튼 + (열렸을 때) 패널
export function renderChangeLogFab() {
  const unread = getUnreadChangeCount()
  const open = state.showChangeLog
  const badge = (!open && unread > 0)
    ? `<span class="corner-fab-badge">${unread > 99 ? '99+' : unread}</span>`
    : ''
  const button = `
    <button class="corner-fab changelog-fab ${open ? 'is-open' : ''}" data-action="toggle-changelog" aria-expanded="${open}" title="이슈 변경 알림 기록">
      ${BELL_SVG}
      ${badge}
    </button>
  `
  if (!open) return button
  return button + renderChangeLogPanel()
}

// 오늘이면 "오늘 HH:MM", 아니면 "M월 D일 HH:MM"
function formatChangeTime(at) {
  const d = new Date(at)
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
  return sameDay ? `오늘 ${hm}` : `${d.getMonth() + 1}월 ${d.getDate()}일 ${hm}`
}

// 이슈 키를 Jira 링크로 렌더한 변경 메시지 HTML.
function renderChangeItemHtml(e) {
  const link = renderIssueKeyLink(e.key) // key는 Jira 응답 유래 + 내부에서 안전 처리
  let rest
  if (e.kind === 'status') {
    const to = e.to || '?'
    rest = ` 항목의 상태가 ${escapeHtml(e.from || '?')}에서 ${escapeHtml(to)}${josaRo(to)} 변경되었습니다.`
  } else if (e.kind === 'description') {
    rest = ` 항목의 설명이 변경되었습니다.`
  } else {
    rest = ` 항목에 변경된 요소가 있습니다.`
  }
  return link + rest
}

function renderChangeLogPanel() {
  const entries = getChangeLog()
  const body = entries.length === 0
    ? `<div class="floating-panel-empty">아직 기록된 변경 알림이 없습니다.<br>워치·담당·보고 중인 이슈가 바뀌면 여기에 쌓입니다.</div>`
    : entries.map(e => `
        <div class="changelog-item" data-project="${escapeHtml(getProjectFromKey(e.key))}">
          <span class="changelog-item-dot changelog-kind-${e.kind}"></span>
          <div class="changelog-item-main">
            <div class="changelog-item-text">${renderChangeItemHtml(e)}</div>
            <div class="changelog-item-time">${formatChangeTime(e.at)}</div>
          </div>
        </div>
      `).join('')

  return `
    <div class="floating-panel changelog-panel">
      <div class="floating-panel-header">
        <div class="floating-panel-title">
          ${BELL_SVG.replace('width="20" height="20"', 'width="15" height="15"')}
          <span>이슈 변경 알림</span>
        </div>
        <div class="floating-panel-header-actions">
          ${entries.length ? `<button class="floating-panel-textbtn" data-action="clear-changelog">기록 지우기</button>` : ''}
          <button class="floating-panel-close" data-action="close-changelog" title="닫기" aria-label="닫기">${CLOSE_SVG}</button>
        </div>
      </div>
      <div class="floating-panel-body">${body}</div>
    </div>
  `
}
