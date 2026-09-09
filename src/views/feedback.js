// 오류 신고 / 개선 요청 모달 — 새 문의 작성 / 내 문의 목록 / (관리자) 전체 관리
import { state } from '../state.js'
import { escapeHtml, closeIconSvg } from '../utils.js'
import { isDemoMode } from '../demo.js'

export const FEEDBACK_TYPES = [
  { key: 'bug', label: '오류 신고' },
  { key: 'improve', label: '개선 요청' },
]

export const FEEDBACK_STATUSES = [
  { key: 'open', label: '접수됨' },
  { key: 'in_progress', label: '처리 중' },
  { key: 'done', label: '완료' },
  { key: 'rejected', label: '보류' },
]

const TYPE_LABEL = Object.fromEntries(FEEDBACK_TYPES.map(t => [t.key, t.label]))
const STATUS_LABEL = Object.fromEntries(FEEDBACK_STATUSES.map(s => [s.key, s.label]))

export const FEEDBACK_PLACEHOLDER = {
  bug: '어떤 화면에서, 무엇을 했을 때, 어떤 문제가 생겼는지 적어 주세요.\n예) 작업 로그 기록 탭에서 수정 버튼을 눌렀는데 저장이 안 됩니다.',
  improve: '어떤 점이 불편했고, 어떻게 바뀌면 좋을지 적어 주세요.\n예) 요약 탭에서 월 단위 합계도 보고 싶어요.',
}

// 헤더 우측 버튼 (message-square 아이콘)
export function renderFeedbackButton() {
  // 데모 모드는 토큰이 없어 전송할 수 없으므로 버튼 자체를 숨긴다
  if (isDemoMode()) return ''
  return `
    <button class="btn btn-sm header-feedback-btn" id="btn-feedback" title="이 서비스의 오류 신고 · 개선 요청">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <span>오류 신고 · 개선 요청</span>
    </button>
  `
}

function formatDateTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function renderTypeBadge(type) {
  return `<span class="feedback-badge feedback-type-${escapeHtml(type)}">${escapeHtml(TYPE_LABEL[type] || type)}</span>`
}

function renderStatusBadge(status) {
  return `<span class="feedback-badge feedback-status-${escapeHtml(status)}">${escapeHtml(STATUS_LABEL[status] || status)}</span>`
}

// 진단 정보 (관리자 전용, 접힘)
function renderContext(ctx) {
  if (!ctx || Object.keys(ctx).length === 0) return ''
  const rows = Object.entries(ctx)
    .filter(([k]) => k !== 'displayName')
    .map(([k, v]) => `<div class="feedback-ctx-row"><span class="feedback-ctx-key">${escapeHtml(k)}</span><span class="feedback-ctx-val">${escapeHtml(String(v))}</span></div>`)
    .join('')
  return `
    <details class="feedback-ctx">
      <summary>진단 정보</summary>
      ${rows}
    </details>
  `
}

// 관리자 편집 영역 (상태 변경 + 답변)
function renderAdminControls(item, m) {
  const busy = m.updating.has(item.id)
  const draft = m.adminDrafts[item.id] || {}
  const status = draft.status ?? item.status
  const reply = draft.reply ?? (item.reply || '')
  return `
    <div class="feedback-admin" data-fb-id="${escapeHtml(item.id)}">
      <div class="feedback-admin-row">
        <label class="modal-label" for="fb-status-${escapeHtml(item.id)}">처리 상태</label>
        <select class="modal-input feedback-status-select" id="fb-status-${escapeHtml(item.id)}" data-fb-status="${escapeHtml(item.id)}" ${busy ? 'disabled' : ''}>
          ${FEEDBACK_STATUSES.map(s => `<option value="${s.key}" ${s.key === status ? 'selected' : ''}>${s.label}</option>`).join('')}
        </select>
      </div>
      <label class="modal-label" for="fb-reply-${escapeHtml(item.id)}">답변 <span class="modal-label-note">(문의한 사용자에게 표시됩니다)</span></label>
      <textarea class="modal-textarea feedback-reply-input" id="fb-reply-${escapeHtml(item.id)}" data-fb-reply="${escapeHtml(item.id)}" placeholder="처리 결과나 안내 문구를 남겨 주세요." ${busy ? 'disabled' : ''}>${escapeHtml(reply)}</textarea>
      <div class="feedback-admin-actions">
        <button type="button" class="btn btn-sm btn-danger" data-fb-delete="${escapeHtml(item.id)}" ${busy ? 'disabled' : ''}>삭제</button>
        <button type="button" class="btn btn-sm btn-primary" data-fb-save="${escapeHtml(item.id)}" ${busy ? 'disabled' : ''}>${busy ? '저장 중...' : '저장'}</button>
      </div>
      ${renderContext(item.context)}
    </div>
  `
}

function renderItem(item, m, { admin }) {
  const expanded = m.expanded.has(item.id)
  const author = item.author?.displayName ? escapeHtml(item.author.displayName) : ''
  const canWithdraw = !admin && item.status === 'open'
  const busy = m.updating.has(item.id)
  return `
    <div class="feedback-item ${expanded ? 'is-open' : ''}" data-fb-item="${escapeHtml(item.id)}">
      <button type="button" class="feedback-item-head" data-fb-toggle="${escapeHtml(item.id)}" aria-expanded="${expanded}">
        <span class="feedback-item-badges">${renderTypeBadge(item.type)}${renderStatusBadge(item.status)}</span>
        <span class="feedback-item-title">${escapeHtml(item.title)}</span>
        <span class="feedback-item-meta">${admin && author ? `${author} · ` : ''}${formatDateTime(item.createdAt)}</span>
      </button>
      ${expanded ? `
        <div class="feedback-item-body">
          <div class="feedback-item-text">${escapeHtml(item.body)}</div>
          ${item.reply ? `
            <div class="feedback-reply">
              <div class="feedback-reply-label">답변</div>
              <div class="feedback-item-text">${escapeHtml(item.reply)}</div>
            </div>
          ` : ''}
          ${admin ? renderAdminControls(item, m) : ''}
          ${canWithdraw ? `
            <div class="feedback-admin-actions">
              <button type="button" class="btn btn-sm btn-danger" data-fb-delete="${escapeHtml(item.id)}" ${busy ? 'disabled' : ''}>문의 취소</button>
            </div>
          ` : ''}
        </div>
      ` : ''}
    </div>
  `
}

function renderList(m, { admin }) {
  const list = admin ? m.allItems : m.items
  if (m.loading && !list) return `<div class="feedback-empty">불러오는 중...</div>`
  if (m.listError) return `<div class="modal-error">${escapeHtml(m.listError)}</div>`
  const items = list || []
  if (items.length === 0) {
    return `<div class="feedback-empty">${admin ? '아직 접수된 문의가 없습니다.' : '아직 보낸 문의가 없습니다.'}</div>`
  }
  return `<div class="feedback-list">${items.map(it => renderItem(it, m, { admin })).join('')}</div>`
}

function renderNewForm(m) {
  const d = m.draft
  return `
    <div class="modal-field">
      <label class="modal-label">문의 유형</label>
      <div class="settings-segmented" role="radiogroup" aria-label="문의 유형">
        ${FEEDBACK_TYPES.map(t => `
          <button type="button" class="settings-segmented-btn ${d.type === t.key ? 'active' : ''}" role="radio" aria-checked="${d.type === t.key}" data-fb-type="${t.key}">${t.label}</button>
        `).join('')}
      </div>
    </div>
    <div class="modal-field">
      <label class="modal-label" for="feedback-title">제목 <span class="modal-label-required">*</span></label>
      <input type="text" class="modal-input" id="feedback-title" maxlength="100" placeholder="한 줄로 요약해 주세요" value="${escapeHtml(d.title)}" ${m.submitting ? 'disabled' : ''} />
    </div>
    <div class="modal-field">
      <label class="modal-label" for="feedback-body">내용 <span class="modal-label-required">*</span></label>
      <textarea class="modal-textarea feedback-body-input" id="feedback-body" maxlength="4000" placeholder="${escapeHtml(FEEDBACK_PLACEHOLDER[d.type] || '')}" ${m.submitting ? 'disabled' : ''}>${escapeHtml(d.body)}</textarea>
    </div>
    <div class="feedback-hint">
      현재 화면 · 브라우저 정보 · 로그인 계정 이름이 함께 전송됩니다. Jira에는 기록되지 않습니다.
    </div>
    ${m.error ? `<div class="modal-error">${escapeHtml(m.error)}</div>` : ''}
    <div class="modal-actions">
      <button type="button" class="btn" id="feedback-cancel" ${m.submitting ? 'disabled' : ''}>취소</button>
      <button type="button" class="btn btn-primary" id="feedback-submit" ${m.submitting ? 'disabled' : ''}>${m.submitting ? '보내는 중...' : '보내기'}</button>
    </div>
  `
}

// 탭 바 (문의 건수 표시) — 목록 로드 후 건수만 갱신할 때 단독으로도 쓴다
export function renderFeedbackTabs(m) {
  const mineCount = m.items ? m.items.length : null
  const allCount = m.allItems ? m.allItems.length : null
  const tabs = [
    { id: "new", label: "새 문의" },
    { id: "mine", label: `내 문의${mineCount !== null ? ` (${mineCount})` : ""}` },
  ]
  if (m.isAdmin) tabs.push({ id: "all", label: `전체 관리${allCount !== null ? ` (${allCount})` : ""}` })
  return tabs.map(t => `
    <button type="button" class="feedback-tab ${m.tab === t.id ? "active" : ""}" role="tab" aria-selected="${m.tab === t.id}" data-fb-tab="${t.id}">${t.label}</button>
  `).join("")
}

// 모달 카드 내부 (헤더 + 탭 + 본문). 상태 변화 시 카드 내부만 교체해
// 오버레이/카드 진입 애니메이션이 다시 재생되지 않게 한다.
export function renderFeedbackModalInner() {
  const m = state.showFeedback
  if (!m) return ""
  let bodyHtml
  if (m.tab === "new") bodyHtml = renderNewForm(m)
  else if (m.tab === "all") bodyHtml = renderList(m, { admin: true })
  else bodyHtml = renderList(m, { admin: false })
  return `
    <div class="feedback-head">
      <div class="modal-title">오류 신고 · 개선 요청</div>
      <button type="button" class="btn-icon feedback-close" id="feedback-close" title="닫기" aria-label="닫기">${closeIconSvg()}</button>
    </div>
    <div class="feedback-tabs" id="feedback-tabs" role="tablist">
      ${renderFeedbackTabs(m)}
    </div>
    <div class="feedback-body">
      ${bodyHtml}
    </div>
  `
}

export function renderFeedbackModal() {
  if (!state.showFeedback) return ""
  return `
    <div class="modal-overlay" id="feedback-overlay">
      <div class="modal modal-feedback" id="feedback-card">
        ${renderFeedbackModalInner()}
      </div>
    </div>
  `
}
