// 현재 작업 세션 카드 영역
import { loadSessions, getSessionStartedAt, getSessionElapsedMinutes } from '../storage.js'
import { escapeHtml, formatMinutes, renderIssueKeyLink } from '../utils.js'

export function renderActiveSessions() {
  const sessions = loadSessions()

  if (sessions.length === 0) {
    return `
      <div class="active-sessions">
        <div class="section-title-row"><span class="section-title">현재 작업</span><button class="btn btn-sm" id="btn-manual-log">+ 수동 기록</button></div>
        <div class="no-session">진행 중인 작업이 없습니다. 아래 이슈 목록에서 작업을 시작하세요.</div>
      </div>
    `
  }

  const cards = sessions.map(session => {
    const startedAt = getSessionStartedAt(session)
    const totalMinutes = getSessionElapsedMinutes(session)
    const segCount = session.segments.length
    return `
    <div class="session-card ${session.status}" data-issue-key="${session.issueKey}" data-issue-summary="${escapeHtml(session.summary || '')}">
      <div class="session-info">
        <div class="session-issue">
          ${renderIssueKeyLink(session.issueKey)}
          <span class="issue-summary">${escapeHtml(session.summary || '')}</span>
        </div>
        <div class="session-meta">
          <span class="session-status ${session.status}">
            ${session.status === 'active' ? '● 진행 중' : '⏸ 중단됨'}
          </span>
          <span class="session-started-at">${startedAt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 시작${segCount > 1 ? ` · ${segCount}구간` : ''}</span>
          <button class="btn-link session-adjust-start" data-action="adjust-session-start" data-key="${session.issueKey}" title="직전 작업 로그 종료 시간으로 시작 시간 변경">직전 종료 시간으로</button>
        </div>
      </div>
      <div class="session-actions">
        <span class="session-timer" data-segments='${JSON.stringify(session.segments.map(s => ({ start: s.start.getTime(), end: s.end ? s.end.getTime() : null })))}' data-status="${session.status}">
          ${formatMinutes(totalMinutes)}
        </span>
        ${session.status === 'active' ? `
          <button class="btn btn-sm" data-action="pause" data-key="${session.issueKey}">중단</button>
          <button class="btn btn-primary btn-sm" data-action="finish" data-key="${session.issueKey}">종료</button>
          <button class="btn btn-danger btn-sm" data-action="cancel" data-key="${session.issueKey}">취소</button>
        ` : `
          <button class="btn btn-sm" data-action="resume" data-key="${session.issueKey}">재개</button>
          <button class="btn btn-primary btn-sm" data-action="finish" data-key="${session.issueKey}">종료</button>
          <button class="btn btn-danger btn-sm" data-action="cancel" data-key="${session.issueKey}">취소</button>
        `}
      </div>
    </div>
    `
  }).join('')

  return `
    <div class="active-sessions">
      <div class="section-title-row"><span class="section-title">현재 작업</span><button class="btn btn-sm" id="btn-manual-log">+ 수동 기록</button></div>
      ${cards}
    </div>
  `
}
