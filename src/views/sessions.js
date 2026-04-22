// 현재 작업 세션 카드 영역
import { NO_ISSUE_KEY, NO_ISSUE_SUMMARY } from '../state.js'
import { loadSessions, getSessionStartedAt, getSessionElapsedMinutes } from '../storage.js'
import { escapeHtml, formatMinutes, renderIssueKeyLink, getProjectFromKey } from '../utils.js'

export function renderActiveSessions() {
  const sessions = loadSessions()

  if (sessions.length === 0) {
    return `
      <div class="active-sessions">
        <div class="section-title-row"><span class="section-title">현재 작업</span><button class="btn btn-sm" id="btn-manual-log">+ 수동 기록</button></div>
        <div class="no-session">
          <div>진행 중인 작업이 없습니다. 아래 이슈 목록에서 작업을 시작하세요.</div>
          <button class="btn btn-sm no-session-start" id="btn-start-no-issue">일감 없이 작업 시작하기</button>
        </div>
      </div>
    `
  }

  const cards = sessions.map(session => {
    const startedAt = getSessionStartedAt(session)
    const totalMinutes = getSessionElapsedMinutes(session)
    const segCount = session.segments.length
    const isIssueless = session.issueKey === NO_ISSUE_KEY
    const issueDisplay = isIssueless
      ? `<span class="issue-key issue-key-noissue">${escapeHtml(NO_ISSUE_SUMMARY)}</span>`
      : `${renderIssueKeyLink(session.issueKey)}<span class="issue-summary">${escapeHtml(session.summary || '')}</span>`
    const projectAttr = isIssueless ? '' : `data-project="${getProjectFromKey(session.issueKey)}"`
    return `
    <div class="session-card ${session.status}${isIssueless ? ' session-card-noissue' : ''}" data-issue-key="${escapeHtml(session.issueKey)}" data-issue-summary="${escapeHtml(session.summary || '')}" ${projectAttr}>
      <div class="session-info">
        <div class="session-issue">
          ${issueDisplay}
        </div>
        <div class="session-meta">
          <span class="session-status ${session.status}">
            ${session.status === 'active' ? '● 진행 중' : '<span class="pause-icon" aria-hidden="true"></span>중단됨'}
          </span>
          <span class="session-started-at">${startedAt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 시작${segCount > 1 ? ` · ${segCount}구간` : ''}</span>
          <button class="btn-link session-adjust-start" data-action="adjust-session-start" data-key="${escapeHtml(session.issueKey)}" title="직전 작업 로그 종료 시간으로 시작 시간 변경">직전 종료 시간으로</button>
          <button class="btn-link session-swap-issue" data-action="swap-issue" data-key="${escapeHtml(session.issueKey)}" data-summary="${escapeHtml(session.summary || '')}" title="현재 세션의 일감을 다른 이슈로 교체">일감 교체</button>
        </div>
      </div>
      <div class="session-actions">
        <span class="session-timer" data-segments='${JSON.stringify(session.segments.map(s => ({ start: s.start.getTime(), end: s.end ? s.end.getTime() : null })))}' data-status="${session.status}">
          ${formatMinutes(totalMinutes)}
        </span>
        ${session.status === 'active' ? `
          <button class="btn btn-sm" data-action="pause" data-key="${escapeHtml(session.issueKey)}">중단</button>
          <button class="btn btn-primary btn-sm" data-action="finish" data-key="${escapeHtml(session.issueKey)}">종료</button>
          <button class="btn btn-danger btn-sm" data-action="cancel" data-key="${escapeHtml(session.issueKey)}">취소</button>
        ` : `
          <button class="btn btn-sm" data-action="resume" data-key="${escapeHtml(session.issueKey)}">재개</button>
          <button class="btn btn-primary btn-sm" data-action="finish" data-key="${escapeHtml(session.issueKey)}">종료</button>
          <button class="btn btn-danger btn-sm" data-action="cancel" data-key="${escapeHtml(session.issueKey)}">취소</button>
        `}
      </div>
    </div>
    `
  }).join('')

  return `
    <div class="active-sessions">
      <div class="section-title-row"><span class="section-title">현재 작업</span><button class="btn btn-sm" id="btn-manual-log">+ 수동 기록</button></div>
      ${cards}
      <div class="session-storage-notice">
        ⚠️ <strong>종료</strong>를 눌러 Jira에 기록하기 전까지 세션은 이 브라우저에만 저장됩니다.
        브라우저 데이터를 삭제하면 진행 중 세션이 사라질 수 있어요.
      </div>
    </div>
  `
}
