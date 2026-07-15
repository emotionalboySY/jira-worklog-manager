// 이슈 변경 알림: 플로팅 버튼(즐겨찾기 버튼 위) + 기록 모달
import { getChangeLog, getUnreadChangeCount } from '../issueChanges.js'
import { escapeHtml, renderIssueKeyLink, getProjectFromKey, josaRo } from '../utils.js'

// 즐겨찾기 플로팅 버튼 바로 위에 뜨는 종 모양 버튼 (안 읽은 변경 수 배지 포함)
export function renderChangeLogFab() {
  const unread = getUnreadChangeCount()
  const badge = unread > 0
    ? `<span class="changelog-fab-badge">${unread > 99 ? '99+' : unread}</span>`
    : ''
  return `
    <button class="changelog-fab" data-action="open-changelog" title="이슈 변경 알림 기록" aria-label="이슈 변경 알림 기록">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
      ${badge}
    </button>
  `
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

export function renderChangeLogModal() {
  const entries = getChangeLog()
  const body = entries.length === 0
    ? `<div class="changelog-empty">아직 기록된 변경 알림이 없습니다.<br>워치·담당·보고 중인 이슈가 바뀌면 여기에 쌓입니다.</div>`
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
    <div class="modal-overlay" id="changelog-overlay" data-action="changelog-overlay">
      <div class="modal modal-changelog">
        <div class="modal-title changelog-title-row">
          <span>이슈 변경 알림</span>
          ${entries.length ? `<button class="btn btn-sm changelog-clear" data-action="clear-changelog">기록 지우기</button>` : ''}
        </div>
        <div class="changelog-list">${body}</div>
        <div class="modal-actions">
          <button class="btn" data-action="close-changelog">닫기</button>
        </div>
      </div>
    </div>
  `
}
