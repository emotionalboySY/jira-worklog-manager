// 모든 모달 + 이슈 키 자동완성 관련 로직
import { state, ISSUE_KEY_PATTERN, LUNCH_START, LUNCH_END, WORKLOG_CACHE_KEY, NO_ISSUE_KEY, NO_ISSUE_SUMMARY, EXCLUDED_CREATE_PROJECT_KEYS } from '../state.js'
import {
  loadSessions,
  loadFavorites,
  loadWorklogCache,
  getSegmentDetails,
} from '../storage.js'
import { searchIssuesByKey } from '../jira.js'
import {
  toDateString,
  escapeHtml,
  formatMinutes,
  getActiveIssues,
  getStatusCss,
  getShortStatusLabel,
  getProjectKeysOrFallback,
} from '../utils.js'
import { loadWorklogs } from '../actions.js'
import { renderAdf } from '../adf.js'
import { getCachedMyself } from '../jira.js'

// 이슈 키 형식 검사 (예: DKT-123) — ISSUE_KEY_PATTERN도 여기에서 재노출
export { ISSUE_KEY_PATTERN }

export function isValidIssueKeyFormat(key) {
  return ISSUE_KEY_PATTERN.test(key)
}

// 이미 로드된 이슈 목록에서 찾기 (API 호출 없이)
export function findLoadedIssue(key) {
  const pool = [...getActiveIssues(), ...(state.searchResults || [])]
  return pool.find(i => i.key === key) || null
}

// 특정 날짜의 worklog 중 가장 늦은 endTime 반환 (없으면 null)
export function getLatestEndTimeForDate(dateStr) {
  const logs = state.worklogsByDate[dateStr] || []
  if (logs.length === 0) return null
  return logs.reduce((max, l) => (l.endTime > max ? l.endTime : max), '00:00')
}

// 월 캐시 무효화 + 재로드
export function invalidateWorklogMonth(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  state.worklogsLoadedMonths.delete(monthKey)
  for (const key of Object.keys(state.worklogsByDate)) {
    if (key.startsWith(monthKey)) delete state.worklogsByDate[key]
  }
  // localStorage 캐시도 제거
  const cache = loadWorklogCache()
  if (cache?.months?.[monthKey]) {
    delete cache.months[monthKey]
    try { localStorage.setItem(WORKLOG_CACHE_KEY, JSON.stringify(cache)) } catch {}
  }
  loadWorklogs(d.getFullYear(), d.getMonth())
}

// ========== 종료 모달 ==========
export function renderModal() {
  const sessions = loadSessions()
  const session = sessions.find(s => s.issueKey === state.showModal)
  if (!session) return ''

  // 진행 중 세션이면 마지막 구간의 종료 시각은 '지금'으로 간주해 계산
  const details = getSegmentDetails(session)

  const fmtTime = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  const isIssueless = session.issueKey === NO_ISSUE_KEY
  const isMulti = details.length > 1

  // 일감 미지정 세션은 Jira 기록 시 이슈를 반드시 골라야 하므로 입력 필드로 대체
  let issueBlockHtml
  if (isIssueless) {
    let keyStatusHtml = ''
    if (state.finishIssueCheck) {
      if (state.finishIssueCheck.status === 'checking') {
        keyStatusHtml = `<div class="input-hint">확인 중...</div>`
      } else if (state.finishIssueCheck.status === 'ok') {
        keyStatusHtml = `<div class="input-hint ok">✓ ${escapeHtml(state.finishIssueCheck.summary || '')}</div>`
      } else if (state.finishIssueCheck.status === 'error') {
        keyStatusHtml = `<div class="input-hint error">⚠ ${escapeHtml(state.finishIssueCheck.message || '')}</div>`
      }
    }
    issueBlockHtml = `
      <div class="modal-field">
        <label class="modal-label">이슈 키 <span class="modal-label-note">(일감 미지정 세션이므로 기록할 이슈를 선택하세요)</span></label>
        <div class="autocomplete-wrapper">
          <input type="text" class="modal-input" id="finish-issue-key" placeholder="예: DKT-123 또는 키워드" autocomplete="off" />
          <div class="autocomplete-dropdown" id="finish-key-dropdown"></div>
        </div>
        ${keyStatusHtml}
      </div>
    `
  } else {
    issueBlockHtml = `
      <div class="modal-issue-info">
        <span class="issue-key">${session.issueKey}</span>
        <span class="modal-issue-summary">${escapeHtml(session.summary || '')}</span>
        <button type="button" class="btn-link modal-issue-swap" data-action="swap-issue" data-key="${escapeHtml(session.issueKey)}" data-summary="${escapeHtml(session.summary || '')}">일감 교체</button>
      </div>
    `
  }

  // 구간별 편집 가능한 시작/종료 시간 UI (마지막 구간만 '지금' 버튼 제공)
  // 다중 구간일 때만 각 구간을 개별 삭제할 수 있음
  const segmentsHtml = details.map((seg, i) => {
    const startTime = fmtTime(seg.start)
    const endTime = fmtTime(seg.end)
    const dateStr = fmtDate(seg.start)
    const lastIdx = details.length - 1
    const showNowBtn = i === lastIdx
    const headRow = isMulti
      ? `
        <div class="finish-segment-head">
          <label class="modal-label">구간 ${i + 1}</label>
          <button type="button" class="btn-link finish-seg-delete" data-action="delete-segment" data-seg-idx="${i}" title="이 구간을 삭제 (Jira에 기록되지 않음)">구간 삭제</button>
        </div>
      `
      : ''
    return `
      <div class="modal-field finish-segment" data-seg-idx="${i}" data-seg-date="${dateStr}">
        ${headRow}
        <div class="finish-segment-row">
          <input type="time" class="modal-input finish-seg-start" data-seg-idx="${i}" value="${startTime}" aria-label="시작 시간" />
          <span class="finish-seg-arrow">→</span>
          <input type="time" class="modal-input finish-seg-end" data-seg-idx="${i}" value="${endTime}" aria-label="종료 시간" />
          ${showNowBtn ? `<button type="button" class="btn btn-sm finish-seg-now" data-seg-idx="${i}">지금</button>` : ''}
        </div>
        <div class="duration-readout finish-seg-duration" data-seg-idx="${i}">-</div>
      </div>
    `
  }).join('')

  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal">
        <div class="modal-title">작업 종료</div>
        ${issueBlockHtml}
        ${isMulti ? `<div class="modal-section-label">작업 구간 (${details.length}건)</div>` : `<div class="modal-section-label">작업 시간</div>`}
        ${segmentsHtml}
        <div class="modal-info finish-total-row">
          <span class="modal-info-label">실 작업 시간 합계</span>
          <span class="modal-info-value" id="finish-total-readout">-</span>
        </div>
        <div class="modal-field">
          <label class="modal-label">작업 내용 (코멘트)</label>
          <textarea class="modal-textarea" id="finish-comment" placeholder="작업 내용을 입력하세요..."></textarea>
        </div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">취소</button>
          <button class="btn btn-primary" id="modal-submit">Jira에 기록</button>
        </div>
      </div>
    </div>
  `
}

// 종료 모달 구간별 소요시간 읽고 합계 readout 업데이트
// - 모든 구간의 시작/종료 input값을 계산해 구간별 readout과 총 합계 readout을 갱신
// - 유효하지 않은 구간은 error 클래스 + 안내 문구 표시
// 반환: { valid, totalActual, perSegment: [{ valid, actualMinutes, startTime, endTime, date, message }] }
export function updateFinishDurationReadouts() {
  const modal = document.getElementById('modal-overlay')
  if (!modal) return { valid: false, totalActual: 0, perSegment: [] }
  const segRows = modal.querySelectorAll('.finish-segment')
  const perSegment = []
  let totalActual = 0
  let anyInvalid = false
  segRows.forEach(row => {
    const i = parseInt(row.dataset.segIdx, 10)
    const date = row.dataset.segDate
    const startInput = row.querySelector('.finish-seg-start')
    const endInput = row.querySelector('.finish-seg-end')
    const readout = row.querySelector('.finish-seg-duration')
    const startTime = startInput?.value || ''
    const endTime = endInput?.value || ''
    const dur = computeDurationFromTimes(startTime, endTime)
    if (!dur.valid) {
      anyInvalid = true
      readout.textContent = dur.message || '-'
      readout.classList.add('error')
      perSegment[i] = { valid: false, actualMinutes: 0, startTime, endTime, date, message: dur.message }
      return
    }
    readout.classList.remove('error')
    const main = formatMinutes(dur.actualMinutes)
    readout.textContent = dur.lunchMinutes > 0
      ? `${main} (점심시간 ${formatMinutes(dur.lunchMinutes)} 제외)`
      : main
    totalActual += dur.actualMinutes
    perSegment[i] = { valid: true, actualMinutes: dur.actualMinutes, startTime, endTime, date }
  })
  const totalEl = document.getElementById('finish-total-readout')
  if (totalEl) {
    totalEl.textContent = totalActual > 0 ? formatMinutes(totalActual) : '-'
    totalEl.classList.toggle('error', anyInvalid)
  }
  return { valid: !anyInvalid, totalActual, perSegment }
}

// ========== 이슈 상태 전이 드롭다운 ==========
// position: fixed로 화면 좌표 기준 배치. 이슈 목록 스크롤 / ESC / 바깥 클릭 시 닫힘.
// transitions=null이면 로딩 중 (전이 조회 API 대기)
export function renderStatusDropdown() {
  const dd = state.statusDropdown
  if (!dd) return ''
  const { rect, transitions, loading, currentStatus } = dd

  // 일부 워크플로우(예: DK)는 현재 상태로 되돌아가는 self-loop 전이가 정의돼 있어
  // Jira API가 그 항목까지 돌려준다. 사용자가 실제로 쓸 일 없고 헷갈리므로 제외.
  // (Jira 웹 UI도 같은 방식으로 필터링함)
  const visible = (transitions || []).filter(t => t.to?.name && t.to.name !== currentStatus)

  // 드롭다운 높이 추정 (뷰포트 초과 여부 판단용)
  // 실제 DOM 높이는 모르므로 항목당 대략 36px + 컨테이너 패딩/보더 감안
  const ITEM_H = 36
  const CHROME = 10
  let estHeight
  if (loading || visible.length === 0) {
    estHeight = 40 + CHROME
  } else {
    estHeight = visible.length * ITEM_H + CHROME
  }

  const GAP = 4
  const EDGE = 8
  const spaceBelow = window.innerHeight - rect.bottom - EDGE
  const spaceAbove = rect.top - EDGE
  const openUp = estHeight > spaceBelow && spaceAbove > spaceBelow
  // 펼치는 방향에서 사용할 수 있는 최대 높이 (뷰포트 밖으로 나가지 않도록)
  const available = openUp ? spaceAbove : spaceBelow
  const maxHeight = Math.max(120, available - GAP)

  const right = Math.max(EDGE, Math.round(window.innerWidth - rect.right))
  const vertical = openUp
    ? `bottom:${Math.round(window.innerHeight - rect.top + GAP)}px;`
    : `top:${Math.round(rect.bottom + GAP)}px;`
  const style = `${vertical} right:${right}px; max-height:${maxHeight}px;`

  if (loading) {
    return `
      <div class="status-dropdown" id="status-dropdown" style="${style}">
        <div class="status-dropdown-loading"><span class="btn-spinner"></span><span>상태 조회 중...</span></div>
      </div>
    `
  }

  if (visible.length === 0) {
    return `
      <div class="status-dropdown" id="status-dropdown" style="${style}">
        <div class="status-dropdown-empty">전환 가능한 상태가 없습니다.</div>
      </div>
    `
  }

  const itemsHtml = visible.map(t => {
    const categoryCss = getStatusCss(t.to?.statusCategory?.key || 'new')
    const label = getShortStatusLabel(t.to?.name || t.name || '-')
    const needsFields = hasRequiredFields(t)
    return `
      <button type="button" class="status-dropdown-item" data-action="apply-transition" data-transition-id="${escapeHtml(String(t.id))}" data-needs-fields="${needsFields ? '1' : '0'}">
        <span class="issue-status ${categoryCss}">${escapeHtml(label)}</span>
        <span class="status-dropdown-transition-name">${escapeHtml(t.name || '')}</span>
      </button>
    `
  }).join('')

  return `
    <div class="status-dropdown" id="status-dropdown" style="${style}">
      ${itemsHtml}
    </div>
  `
}

// ========== 이슈 유형 드롭다운 ==========
// 상세 모달의 좌상단 type 아이콘 클릭 시 표시. 동작은 상태 드롭다운과 동일 (fixed).
export function renderTypeDropdown() {
  const dd = state.typeDropdown
  if (!dd) return ''
  const { rect, types, loading, currentTypeName } = dd

  // 현재 유형은 변경 옵션에서 제외
  const visible = (types || []).filter(t => t.name !== currentTypeName)

  const ITEM_H = 36
  const CHROME = 10
  let estHeight
  if (loading || visible.length === 0) {
    estHeight = 40 + CHROME
  } else {
    estHeight = visible.length * ITEM_H + CHROME
  }

  const GAP = 4
  const EDGE = 8
  const spaceBelow = window.innerHeight - rect.bottom - EDGE
  const spaceAbove = rect.top - EDGE
  const openUp = estHeight > spaceBelow && spaceAbove > spaceBelow
  const available = openUp ? spaceAbove : spaceBelow
  const maxHeight = Math.max(120, available - GAP)

  // 좌상단 type 아이콘 기준 → 왼쪽 정렬이 자연스러움
  const left = Math.max(EDGE, Math.round(rect.left))
  const vertical = openUp
    ? `bottom:${Math.round(window.innerHeight - rect.top + GAP)}px;`
    : `top:${Math.round(rect.bottom + GAP)}px;`
  const style = `${vertical} left:${left}px; max-height:${maxHeight}px;`

  if (loading) {
    return `
      <div class="status-dropdown type-dropdown" id="type-dropdown" style="${style}">
        <div class="status-dropdown-loading"><span class="btn-spinner"></span><span>유형 조회 중...</span></div>
      </div>
    `
  }

  if (visible.length === 0) {
    return `
      <div class="status-dropdown type-dropdown" id="type-dropdown" style="${style}">
        <div class="status-dropdown-empty">변경 가능한 유형이 없습니다.</div>
      </div>
    `
  }

  const itemsHtml = visible.map(t => {
    const iconHtml = t.iconUrl
      ? `<img class="detail-type-icon" src="${escapeHtml(t.iconUrl)}" alt="${escapeHtml(t.name)}" />`
      : ''
    return `
      <button type="button" class="status-dropdown-item type-dropdown-item" data-action="apply-type" data-type-id="${escapeHtml(t.id)}" data-type-name="${escapeHtml(t.name)}" data-type-icon="${escapeHtml(t.iconUrl || '')}">
        ${iconHtml}
        <span class="type-dropdown-name">${escapeHtml(t.name)}</span>
      </button>
    `
  }).join('')

  return `
    <div class="status-dropdown type-dropdown" id="type-dropdown" style="${style}">
      ${itemsHtml}
    </div>
  `
}

// ========== 담당자 드롭다운 ==========
// 이슈 목록의 담당자 아바타 클릭 시 표시. 최초 1회만 API 조회하고 이후 검색은 로컬 필터.
export function renderAssigneeDropdown() {
  const dd = state.assigneeDropdown
  if (!dd) return ''
  const { rect, allUsers, loading, query } = dd
  const users = filterAssignees(allUsers, query)

  const GAP = 4
  const EDGE = 8
  const WIDTH = 280
  // 높이 추정: 검색창(44) + 항목당 40 + 여유
  const rows = Math.max(1, (users || []).length + (query ? 0 : 1)) // 검색어 없을 땐 "미할당" 옵션 추가
  const estHeight = Math.min(420, 44 + rows * 40 + 20)

  const spaceBelow = window.innerHeight - rect.bottom - EDGE
  const spaceAbove = rect.top - EDGE
  const openUp = estHeight > spaceBelow && spaceAbove > spaceBelow
  const available = openUp ? spaceAbove : spaceBelow
  const maxHeight = Math.max(220, available - GAP)

  // 아바타 기준 오른쪽 정렬 (아바타가 행의 오른쪽에 위치하므로)
  const right = Math.max(EDGE, Math.round(window.innerWidth - rect.right))
  const vertical = openUp
    ? `bottom:${Math.round(window.innerHeight - rect.top + GAP)}px;`
    : `top:${Math.round(rect.bottom + GAP)}px;`
  const style = `${vertical} right:${right}px; width:${WIDTH}px; max-height:${maxHeight}px;`

  return `
    <div class="assignee-dropdown" id="assignee-dropdown" style="${style}">
      <div class="assignee-dd-search">
        <input type="text" id="assignee-search-input" placeholder="이름 검색..." value="${escapeHtml(query || '')}" autocomplete="off" />
      </div>
      <div class="assignee-dd-list" id="assignee-dd-list">${renderAssigneeDropdownListContents(dd)}</div>
    </div>
  `
}

// 이름/이메일에 query가 포함된 사용자만 반환 (대소문자 무시)
export function filterAssignees(allUsers, query) {
  if (!Array.isArray(allUsers)) return null
  const q = (query || '').trim().toLowerCase()
  if (!q) return allUsers
  return allUsers.filter(u =>
    (u.displayName || '').toLowerCase().includes(q) ||
    (u.emailAddress || '').toLowerCase().includes(q)
  )
}

// 드롭다운 리스트 영역만 생성. 검색 입력 시 DOM 직접 갱신으로 input 엘리먼트는 보존해
// IME 한글 조합이 끊기지 않도록 함.
export function renderAssigneeDropdownListContents(dd) {
  if (!dd) return ''
  const { allUsers, loading, query } = dd
  const users = filterAssignees(allUsers, query)

  const unassignedItem = !query ? `
    <button type="button" class="assignee-dd-item" data-assignee-id="">
      <span class="assignee-avatar assignee-avatar-empty sm">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6"/></svg>
      </span>
      <span class="assignee-dd-name">미할당</span>
    </button>
  ` : ''

  if (loading) {
    return `<div class="assignee-dd-loading"><span class="btn-spinner"></span><span>사용자 조회 중…</span></div>`
  }
  const items = users || []
  if (items.length === 0) {
    return `
      ${unassignedItem}
      <div class="assignee-dd-empty">${query ? '검색 결과가 없습니다.' : '할당 가능한 사용자가 없습니다.'}</div>
    `
  }
  const itemsHtml = items.map(u => `
    <button type="button" class="assignee-dd-item" data-assignee-id="${escapeHtml(u.accountId)}">
      ${u.avatarUrl
        ? `<img class="assignee-avatar sm" src="${escapeHtml(u.avatarUrl)}" alt="" onerror="this.classList.add('broken')" />`
        : `<span class="assignee-avatar assignee-avatar-empty sm"></span>`}
      <span class="assignee-dd-name">${escapeHtml(u.displayName)}</span>
    </button>
  `).join('')
  return `${unassignedItem}${itemsHtml}`
}

// 전이에 필수 필드(resolution 등)가 있는지 검사
export function hasRequiredFields(transition) {
  const fields = transition.fields || {}
  return Object.values(fields).some(f => f && f.required)
}

// ========== 상태 전이 필드 모달 (resolution 등 추가 입력용) ==========
export function renderTransitionFieldsModal() {
  const ctx = state.transitionFieldsModal
  if (!ctx) return ''
  const { issueKey, transition, values, submitting } = ctx
  const requiredEntries = Object.entries(transition.fields || {}).filter(([, f]) => f && f.required)

  const fieldsHtml = requiredEntries.map(([key, field]) => {
    const label = field.name || key
    const allowed = Array.isArray(field.allowedValues) ? field.allowedValues : []
    const currentVal = values[key] ?? ''

    if (allowed.length > 0) {
      const options = allowed.map(v => {
        const optVal = v.id ?? v.value ?? v.name ?? ''
        const optLabel = v.name ?? v.value ?? v.id ?? ''
        const selected = String(currentVal) === String(optVal) ? 'selected' : ''
        return `<option value="${escapeHtml(String(optVal))}" ${selected}>${escapeHtml(String(optLabel))}</option>`
      }).join('')
      return `
        <div class="modal-field">
          <label class="modal-label">${escapeHtml(label)} *</label>
          <select class="modal-input transition-field" data-field-key="${escapeHtml(key)}" data-field-shape="select">
            <option value="">선택...</option>
            ${options}
          </select>
        </div>
      `
    }
    // 텍스트 입력 (단순 string)
    return `
      <div class="modal-field">
        <label class="modal-label">${escapeHtml(label)} *</label>
        <textarea class="modal-textarea transition-field" data-field-key="${escapeHtml(key)}" data-field-shape="text">${escapeHtml(String(currentVal))}</textarea>
      </div>
    `
  }).join('')

  return `
    <div class="modal-overlay" id="transition-fields-overlay">
      <div class="modal">
        <div class="modal-title">${escapeHtml(issueKey)} 상태 전환</div>
        <div class="modal-section-label">
          <strong>${escapeHtml(transition.to?.name || transition.name || '')}</strong> 상태로 전환하려면 다음 정보가 필요합니다.
        </div>
        ${fieldsHtml}
        <div class="modal-actions">
          <button class="btn" id="transition-fields-cancel" ${submitting ? 'disabled' : ''}>취소</button>
          <button class="btn btn-primary ${submitting ? 'is-loading' : ''}" id="transition-fields-submit" ${submitting ? 'disabled' : ''}>
            ${submitting ? '<span class="btn-spinner"></span>' : '전환'}
          </button>
        </div>
      </div>
    </div>
  `
}

// 전이 필드 값에서 Jira API body용 fields 오브젝트 생성
// 간단 필드만 지원: allowedValues 있으면 { id } 참조, 없으면 string
export function buildTransitionFieldsPayload(transition, values) {
  const payload = {}
  for (const [key, field] of Object.entries(transition.fields || {})) {
    if (!field.required) continue
    const v = values[key]
    if (v === undefined || v === null || v === '') continue
    const allowed = Array.isArray(field.allowedValues) ? field.allowedValues : []
    if (allowed.length > 0) {
      payload[key] = { id: String(v) }
    } else {
      payload[key] = v
    }
  }
  return payload
}

// ========== 세션 일감 교체 모달 ==========
export function renderSwapIssueModal() {
  const ctx = state.showSwapIssue
  if (!ctx) return ''
  const isIssueless = ctx.oldKey === NO_ISSUE_KEY
  const currentLabel = isIssueless
    ? `<span class="issue-key issue-key-noissue">${escapeHtml(NO_ISSUE_SUMMARY)}</span>`
    : `<span class="issue-key">${escapeHtml(ctx.oldKey)}</span><span class="modal-issue-summary">${escapeHtml(ctx.summary || '')}</span>`

  let keyStatusHtml = ''
  if (state.swapIssueCheck) {
    if (state.swapIssueCheck.status === 'checking') {
      keyStatusHtml = `<div class="input-hint">확인 중...</div>`
    } else if (state.swapIssueCheck.status === 'ok') {
      keyStatusHtml = `<div class="input-hint ok">✓ ${escapeHtml(state.swapIssueCheck.summary || '')}</div>`
    } else if (state.swapIssueCheck.status === 'error') {
      keyStatusHtml = `<div class="input-hint error">⚠ ${escapeHtml(state.swapIssueCheck.message || '')}</div>`
    }
  }

  return `
    <div class="modal-overlay" id="swap-issue-overlay">
      <div class="modal">
        <div class="modal-title">일감 교체</div>
        <div class="modal-section-label">현재 일감</div>
        <div class="modal-issue-info">${currentLabel}</div>
        <div class="modal-field">
          <label class="modal-label">새 이슈 키 <span class="modal-label-note">(세션은 그대로 유지되고 일감만 바뀝니다)</span></label>
          <div class="autocomplete-wrapper">
            <input type="text" class="modal-input" id="swap-issue-key" placeholder="예: DKT-123 또는 키워드" autocomplete="off" />
            <div class="autocomplete-dropdown" id="swap-key-dropdown"></div>
          </div>
          ${keyStatusHtml}
        </div>
        <div class="modal-actions">
          <button class="btn" id="swap-issue-cancel">취소</button>
          <button class="btn btn-primary" id="swap-issue-submit">교체</button>
        </div>
      </div>
    </div>
  `
}

// ========== 취소 확인 모달 ==========
export function renderCancelConfirm() {
  const label = state.showCancelConfirm === NO_ISSUE_KEY
    ? NO_ISSUE_SUMMARY
    : state.showCancelConfirm
  return `
    <div class="modal-overlay" id="cancel-overlay">
      <div class="modal">
        <div class="modal-title">작업 로깅 취소</div>
        <p style="color: var(--text); margin-bottom: 20px;">
          <strong style="color: var(--text-bright);">${escapeHtml(label)}</strong> 작업에 대한 로깅을 취소하시겠습니까?<br>
          <span style="color: var(--text-dim); font-size: 12px;">기록되지 않은 작업 시간은 사라집니다.</span>
        </p>
        <div class="modal-actions">
          <button class="btn" id="cancel-confirm-no">아니오</button>
          <button class="btn btn-danger" id="cancel-confirm-yes">취소하기</button>
        </div>
      </div>
    </div>
  `
}

// ========== 새 일감 생성 모달 ==========
export function renderCreateIssueModal() {
  const m = state.showCreateIssue
  if (!m) return ''

  // 프로젝트 선택지에서 EXCLUDED_CREATE_PROJECT_KEYS(예: MDP) 제외
  const projects = (state.realProjects || []).filter(p => !EXCLUDED_CREATE_PROJECT_KEYS.includes(p.key))
  const meta = m.metaByProject?.[m.projectKey]
  const issuetypes = meta?.issuetypes || []
  const selectedType = issuetypes.find(t => t.id === m.issueTypeId) || null
  const showDuedate = !!selectedType?.hasDuedate

  // 프로젝트 선택 옵션 (팀별 키 사용 — DEFAULT_PROJECT_ORDER 순)
  const projectOptionsHtml = projects.length === 0
    ? `<option value="">프로젝트 정보 로딩 중...</option>`
    : projects.map(p => `<option value="${escapeHtml(p.key)}" ${p.key === m.projectKey ? 'selected' : ''}>${escapeHtml(p.key)} · ${escapeHtml(p.name)}</option>`).join('')

  // 이슈 유형: 선택한 프로젝트의 createmeta 결과
  let typeFieldHtml
  if (m.loadingMeta) {
    typeFieldHtml = `<div class="input-hint"><span class="btn-spinner"></span> 이슈 유형 조회 중...</div>`
  } else if (issuetypes.length === 0 && m.projectKey) {
    typeFieldHtml = `<div class="input-hint error">선택 가능한 이슈 유형이 없습니다.</div>`
  } else {
    typeFieldHtml = `
      <div class="create-issue-types">
        ${issuetypes.map(t => `
          <button type="button" class="create-issue-type ${t.id === m.issueTypeId ? 'active' : ''}" data-create-type-id="${escapeHtml(t.id)}">
            ${t.iconUrl ? `<img class="detail-type-icon" src="${escapeHtml(t.iconUrl)}" alt="" />` : ''}
            <span>${escapeHtml(t.name)}</span>
          </button>
        `).join('')}
      </div>
    `
  }

  // 담당자 영역
  const assigneeHtml = renderCreateAssigneeBlock(m)

  // 항목 연결 (이슈 링크) 영역
  const linkTypes = m.linkTypes || []
  const linkOptions = []
  for (const lt of linkTypes) {
    if (lt.outward) linkOptions.push({ value: `${lt.id}:outward`, label: lt.outward, typeName: lt.name, direction: 'outward' })
    if (lt.inward && lt.inward !== lt.outward) linkOptions.push({ value: `${lt.id}:inward`, label: lt.inward, typeName: lt.name, direction: 'inward' })
  }
  const linksHtml = (m.links || []).map((link, idx) => {
    const optsHtml = linkOptions.map(o => {
      const selected = link.typeName === o.typeName && link.direction === o.direction
      return `<option value="${escapeHtml(o.value)}" ${selected ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
    }).join('')
    const targetErr = m.fieldErrors?.[`link-${idx}`] || ''
    const chipsHtml = (link.targetKeys || []).map(key => `
      <span class="link-target-chip">
        <span>${escapeHtml(key)}</span>
        <button type="button" class="link-target-chip-x" data-action="remove-link-target" data-link-idx="${idx}" data-target-key="${escapeHtml(key)}" aria-label="제거">✕</button>
      </span>
    `).join('')
    const placeholder = (link.targetKeys || []).length === 0
      ? '이슈 키 또는 키워드로 검색'
      : '추가...'
    return `
      <div class="create-issue-link-row" data-link-idx="${idx}">
        <select class="modal-input create-issue-link-type" data-link-idx="${idx}" ${linkTypes.length === 0 ? 'disabled' : ''}>
          ${linkTypes.length === 0 ? '<option>로딩 중...</option>' : optsHtml}
        </select>
        <div class="create-issue-link-targets-wrap">
          <div class="create-issue-link-targets" data-link-idx="${idx}">
            ${chipsHtml}
            <input type="text" class="create-issue-link-search" data-link-idx="${idx}"
              placeholder="${placeholder}" value="${escapeHtml(link.query || '')}" autocomplete="off" />
          </div>
          <div class="create-issue-link-suggestions" id="create-issue-link-suggestions-${idx}"></div>
        </div>
        <button type="button" class="btn btn-sm create-issue-link-remove" data-action="remove-create-link" data-link-idx="${idx}" aria-label="이 링크 제거">✕</button>
        ${targetErr ? `<div class="input-hint error">${escapeHtml(targetErr)}</div>` : ''}
      </div>
    `
  }).join('')

  // 기한 (issuetype에서 사용 가능 시)
  const duedateHtml = showDuedate ? `
    <div class="modal-field">
      <label class="modal-label">기한 <span class="modal-label-note">(선택)</span></label>
      <input type="date" class="modal-input" id="create-issue-duedate" value="${escapeHtml(m.duedate || '')}" />
    </div>
  ` : ''

  const summaryErr = m.fieldErrors?.summary || ''
  const submitting = !!m.submitting

  return `
    <div class="modal-overlay" id="create-issue-overlay">
      <div class="modal modal-create-issue">
        <div class="modal-title">새 일감 생성</div>

        <div class="modal-field">
          <label class="modal-label">프로젝트</label>
          <select class="modal-input" id="create-issue-project" ${submitting ? 'disabled' : ''}>
            ${projectOptionsHtml}
          </select>
        </div>

        <div class="modal-field">
          <label class="modal-label">이슈 유형</label>
          ${typeFieldHtml}
        </div>

        <div class="modal-field">
          <label class="modal-label">일감 요약 <span class="modal-label-required">*</span></label>
          <input type="text" class="modal-input" id="create-issue-summary" maxlength="255"
            value="${escapeHtml(m.summary || '')}" placeholder="간단한 한 줄 요약" autocomplete="off" />
          ${summaryErr ? `<div class="input-hint error">${escapeHtml(summaryErr)}</div>` : ''}
        </div>

        <div class="modal-field">
          <label class="modal-label">설명 <span class="modal-label-note">(선택)</span></label>
          ${renderTiptapToolbar('create-issue-desc-toolbar', 'create-issue-desc-editor')}
          <div class="tiptap-editor-mount create-issue-desc-mount" id="create-issue-desc-editor"></div>
        </div>

        <div class="modal-field">
          <label class="modal-label">담당자 <span class="modal-label-note">(선택)</span></label>
          ${assigneeHtml}
        </div>

        ${duedateHtml}

        <div class="modal-field">
          <div class="modal-label-row">
            <label class="modal-label">항목 연결 <span class="modal-label-note">(선택)</span></label>
            <button type="button" class="btn btn-sm" id="create-issue-add-link" ${linkTypes.length === 0 ? 'disabled' : ''}>+ 연결 추가</button>
          </div>
          <div class="create-issue-links">
            ${linksHtml || '<div class="modal-label-note">아직 추가된 연결이 없습니다.</div>'}
          </div>
        </div>

        ${m.error ? `<div class="modal-error">${escapeHtml(m.error)}</div>` : ''}

        <div class="modal-actions">
          <button class="btn" id="create-issue-cancel" ${submitting ? 'disabled' : ''}>취소</button>
          <button class="btn btn-primary" id="create-issue-submit" ${submitting ? 'disabled' : ''}>
            ${submitting ? '<span class="btn-spinner"></span> 생성 중…' : '생성'}
          </button>
        </div>
      </div>
    </div>
  `
}

// 항목 연결 행의 자동완성 드롭다운 HTML. 각 행마다 별도 element에 직접 innerHTML로 주입.
// (manual-issue-key 자동완성과 동일 패턴 — modals 재렌더 없이 input 보존)
export function renderLinkSuggestionsHtml(idx, link) {
  const q = (link?.query || '').trim()
  const searching = !!link?.searching
  const candidates = link?.suggestions || []
  if (!q && !searching) return ''
  if (candidates.length === 0 && !searching) {
    return `<div class="autocomplete-empty">검색 결과가 없습니다.</div>`
  }
  const activeIdx = link?.activeSuggestionIdx ?? -1
  const itemsHtml = candidates.map((c, i) => `
    <div class="autocomplete-item ${i === activeIdx ? 'active' : ''}" data-action="pick-link-target" data-link-idx="${idx}" data-key="${escapeHtml(c.key)}" data-suggest-idx="${i}">
      <span class="autocomplete-key">${escapeHtml(c.key)}</span>
      <span class="autocomplete-summary">${escapeHtml(c.summary || '')}</span>
    </div>
  `).join('')
  let footer = ''
  if (searching) {
    footer = candidates.length === 0
      ? `<div class="autocomplete-loading"><span class="btn-spinner"></span><span>검색 중...</span></div>`
      : `<div class="autocomplete-footer"><span class="btn-spinner"></span><span>더 검색 중...</span></div>`
  }
  return itemsHtml + footer
}

// 담당자 선택 영역. 검색 input → 결과 리스트(미할당/본인/검색결과). 선택된 사용자만 칩으로.
function renderCreateAssigneeBlock(m) {
  const me = getCachedMyself()
  const usersForProj = m.assigneeUsersByProject?.[m.projectKey] || null
  const query = m.assigneeQuery || ''
  const selected = m._selectedAssignee || null  // { accountId, displayName, avatarUrl }

  // 칩 (선택된 상태)
  const chipHtml = (() => {
    if (m.assigneeAccountId === '__UNASSIGNED__') {
      return `
        <div class="create-assignee-chip">
          <span class="assignee-avatar assignee-avatar-empty sm">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6"/></svg>
          </span>
          <span>미할당</span>
          <button type="button" class="btn-link" data-action="clear-create-assignee">변경</button>
        </div>
      `
    }
    if (selected) {
      const av = selected.avatarUrl
        ? `<img class="assignee-avatar sm" src="${escapeHtml(selected.avatarUrl)}" alt="" />`
        : `<span class="assignee-avatar assignee-avatar-empty sm"></span>`
      return `
        <div class="create-assignee-chip">
          ${av}
          <span>${escapeHtml(selected.displayName)}</span>
          <button type="button" class="btn-link" data-action="clear-create-assignee">변경</button>
        </div>
      `
    }
    return ''
  })()

  if (chipHtml) return chipHtml

  // 검색 영역 — 서버 측 검색 결과를 그대로 표시 (최대 표시 수만 제한)
  const filtered = Array.isArray(usersForProj) ? usersForProj.slice(0, 30) : []

  const meItem = me ? `
    <button type="button" class="assignee-dd-item" data-action="pick-create-assignee" data-assignee-id="${escapeHtml(me.accountId)}">
      ${me.avatarUrl ? `<img class="assignee-avatar sm" src="${escapeHtml(me.avatarUrl)}" alt="" />` : `<span class="assignee-avatar assignee-avatar-empty sm"></span>`}
      <span class="assignee-dd-name">나 (${escapeHtml(me.displayName)})</span>
    </button>
  ` : ''
  const unassignedItem = `
    <button type="button" class="assignee-dd-item" data-action="pick-create-assignee" data-assignee-id="__UNASSIGNED__">
      <span class="assignee-avatar assignee-avatar-empty sm">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6"/></svg>
      </span>
      <span class="assignee-dd-name">미할당</span>
    </button>
  `

  let listHtml
  if (m.loadingAssignees && !usersForProj) {
    listHtml = `<div class="assignee-dd-loading"><span class="btn-spinner"></span><span>사용자 조회 중…</span></div>`
  } else if (filtered.length === 0) {
    listHtml = query
      ? `<div class="assignee-dd-empty">검색 결과가 없습니다.</div>`
      : ''
  } else {
    listHtml = filtered.map(u => `
      <button type="button" class="assignee-dd-item" data-action="pick-create-assignee" data-assignee-id="${escapeHtml(u.accountId)}">
        ${u.avatarUrl ? `<img class="assignee-avatar sm" src="${escapeHtml(u.avatarUrl)}" alt="" />` : `<span class="assignee-avatar assignee-avatar-empty sm"></span>`}
        <span class="assignee-dd-name">${escapeHtml(u.displayName)}</span>
      </button>
    `).join('')
  }

  return `
    <div class="create-assignee-search">
      <input type="text" class="modal-input" id="create-issue-assignee-input"
        placeholder="이름 검색 (또는 본인/미할당 선택)" value="${escapeHtml(query)}" autocomplete="off" />
      <div class="create-assignee-list">
        ${unassignedItem}
        ${meItem}
        ${listHtml}
      </div>
    </div>
  `
}

// ========== 워크로그 수정 모달 ==========
export function renderEditWorklogModal() {
  if (!state.editingWorklog) return ''
  const w = state.editingWorklog
  // 시작 시간 + 소요 시간(분)으로부터 종료 시간 역산
  const [sh, sm] = w.startTime.split(':').map(Number)
  const totalStartMin = sh * 60 + sm
  const totalEndMin = totalStartMin + (w.durationHours * 60 + w.durationMins)
  const endTime = `${String(Math.floor(totalEndMin / 60) % 24).padStart(2, '0')}:${String(totalEndMin % 60).padStart(2, '0')}`
  return `
    <div class="modal-overlay" id="edit-worklog-overlay">
      <div class="modal">
        <div class="modal-title">작업 로그 수정</div>
        <div class="modal-issue-info">
          <span class="issue-key">${w.issueKey}</span>
          <span class="modal-issue-summary">${escapeHtml(w.summary || '')}</span>
        </div>
        <div class="modal-field">
          <label class="modal-label">시작 시간</label>
          <input type="time" class="modal-input" id="edit-start-time" value="${w.startTime}" />
        </div>
        <div class="modal-field">
          <label class="modal-label">종료 시간</label>
          <div class="time-with-btn">
            <input type="time" class="modal-input" id="edit-end-time" value="${endTime}" />
            <button type="button" class="btn btn-sm" id="edit-end-now">지금</button>
          </div>
        </div>
        <div class="modal-field">
          <label class="modal-label">소요 시간</label>
          <div class="duration-readout" id="edit-duration-readout">-</div>
        </div>
        <div class="modal-field">
          <label class="modal-label">작업 내용</label>
          <textarea class="modal-textarea" id="edit-comment">${escapeHtml(w.comment || '')}</textarea>
        </div>
        <div class="modal-actions">
          <button class="btn" id="edit-worklog-cancel">취소</button>
          <button class="btn btn-primary" id="edit-worklog-submit">저장</button>
        </div>
      </div>
    </div>
  `
}

// ========== 워크로그 삭제 확인 모달 ==========
export function renderDeleteWorklogConfirm() {
  if (!state.deletingWorklog) return ''
  return `
    <div class="modal-overlay" id="delete-worklog-overlay">
      <div class="modal">
        <div class="modal-title">작업 로그 삭제</div>
        <p style="color: var(--text); margin-bottom: 20px;">
          <strong style="color: var(--text-bright);">${state.deletingWorklog.issueKey}</strong>의 작업 로그를 삭제하시겠습니까?<br>
          <span style="color: var(--text-dim); font-size: 12px;">삭제된 작업 로그는 복구할 수 없습니다.</span>
        </p>
        <div class="modal-actions">
          <button class="btn" id="delete-worklog-no">취소</button>
          <button class="btn btn-danger" id="delete-worklog-yes">삭제</button>
        </div>
      </div>
    </div>
  `
}

// ========== 수동 기록 모달 ==========
export function renderManualLogModal() {
  const ctx = state.showManualLog || {}
  const todayStr = toDateString(new Date())
  const now = new Date()
  const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  // 시작 시간 기본값: 오늘 날짜 worklog의 가장 늦은 endTime, 없으면 현재 시각
  const defaultStartTime = getLatestEndTimeForDate(todayStr) || nowTime
  const initialKey = ctx.issueKey || ''
  const initialSummary = ctx.summary || ''
  // 이슈 키 상태 표시
  let keyStatusHtml = ''
  if (state.manualIssueCheck) {
    if (state.manualIssueCheck.status === 'checking') {
      keyStatusHtml = `<div class="input-hint">확인 중...</div>`
    } else if (state.manualIssueCheck.status === 'ok') {
      keyStatusHtml = `<div class="input-hint ok">✓ ${escapeHtml(state.manualIssueCheck.summary)}</div>`
    } else if (state.manualIssueCheck.status === 'error') {
      keyStatusHtml = `<div class="input-hint error">⚠ ${escapeHtml(state.manualIssueCheck.message)}</div>`
    }
  } else if (initialSummary) {
    keyStatusHtml = `<div class="input-hint ok">✓ ${escapeHtml(initialSummary)}</div>`
  }

  return `
    <div class="modal-overlay" id="manual-log-overlay">
      <div class="modal">
        <div class="modal-title">수동 작업 기록</div>
        <div class="modal-field">
          <label class="modal-label">이슈 키</label>
          <div class="autocomplete-wrapper">
            <input type="text" class="modal-input" id="manual-issue-key" placeholder="예: DKT-123 또는 키워드" value="${escapeHtml(initialKey)}" autocomplete="off" />
            <div class="autocomplete-dropdown" id="manual-key-dropdown"></div>
          </div>
          ${keyStatusHtml}
        </div>
        <div class="modal-field">
          <label class="modal-label">작업 날짜</label>
          <input type="date" class="modal-input" id="manual-date" value="${todayStr}" max="${todayStr}" />
        </div>
        <div class="modal-field">
          <label class="modal-label">시작 시간</label>
          <input type="time" class="modal-input" id="manual-start-time" value="${defaultStartTime}" data-autofilled="${defaultStartTime === nowTime ? '0' : '1'}" />
        </div>
        <div class="modal-field">
          <label class="modal-label">종료 시간</label>
          <div class="time-with-btn">
            <input type="time" class="modal-input" id="manual-end-time" value="${nowTime}" />
            <button type="button" class="btn btn-sm" id="manual-end-now">지금</button>
          </div>
        </div>
        <div class="modal-field">
          <label class="modal-label">소요 시간</label>
          <div class="duration-readout" id="manual-duration-readout">-</div>
        </div>
        <div class="modal-field">
          <label class="modal-label">작업 내용</label>
          <textarea class="modal-textarea" id="manual-comment" placeholder="작업 내용을 입력하세요..."></textarea>
        </div>
        <div class="modal-actions">
          <button class="btn" id="manual-log-cancel">취소</button>
          <button class="btn btn-primary" id="manual-log-submit">Jira에 기록</button>
        </div>
      </div>
    </div>
  `
}

// ========== 이슈 키 자동완성 ==========
// 로컬 풀(realIssues + searchResults + favorites)에서 쿼리 매칭 후보 생성
export function findLocalIssueCandidates(query) {
  const q = query.trim().toUpperCase()
  if (!q) return []
  const pool = new Map()
  for (const i of getActiveIssues()) {
    if (i.key) pool.set(i.key, { key: i.key, summary: i.summary || '' })
  }
  for (const i of (state.searchResults || [])) {
    if (i.key && !pool.has(i.key)) pool.set(i.key, { key: i.key, summary: i.summary || '' })
  }
  for (const f of loadFavorites()) {
    if (f.issueKey && !pool.has(f.issueKey)) pool.set(f.issueKey, { key: f.issueKey, summary: f.summary || '' })
  }
  return [...pool.values()]
    .filter(i => i.key.toUpperCase().includes(q) || (i.summary || '').toUpperCase().includes(q))
    .slice(0, 15)
}

// 자동완성 컨텍스트: 수동 기록 모달 / 종료 모달(일감 미지정) 공용
// 동일 로직을 DOM ID와 state 키만 바꿔 재사용
export const MANUAL_KEY_CTX = {
  inputId: 'manual-issue-key',
  dropdownId: 'manual-key-dropdown',
  checkKey: 'manualIssueCheck',
  activeIdxKey: 'manualKeyActiveIdx',
  timerKey: 'manualKeySearchTimer',
  controllerKey: 'manualKeySearchController',
}

export const FINISH_KEY_CTX = {
  inputId: 'finish-issue-key',
  dropdownId: 'finish-key-dropdown',
  checkKey: 'finishIssueCheck',
  activeIdxKey: 'finishKeyActiveIdx',
  timerKey: 'finishKeySearchTimer',
  controllerKey: 'finishKeySearchController',
}

export const SWAP_KEY_CTX = {
  inputId: 'swap-issue-key',
  dropdownId: 'swap-key-dropdown',
  checkKey: 'swapIssueCheck',
  activeIdxKey: 'swapKeyActiveIdx',
  timerKey: 'swapKeySearchTimer',
  controllerKey: 'swapKeySearchController',
}

export function renderKeyDropdown(ctx, candidates, loading = false) {
  const dropdown = document.getElementById(ctx.dropdownId)
  if (!dropdown) return
  if (candidates.length === 0 && !loading) {
    dropdown.style.display = 'none'
    dropdown.innerHTML = ''
    return
  }
  const activeIdx = state[ctx.activeIdxKey]
  dropdown.style.display = 'block'
  const itemsHtml = candidates.map((c, idx) => `
    <div class="autocomplete-item ${idx === activeIdx ? 'active' : ''}" data-key="${c.key}" data-summary="${escapeHtml(c.summary || '')}" data-idx="${idx}">
      <span class="autocomplete-key">${c.key}</span>
      <span class="autocomplete-summary">${escapeHtml(c.summary || '')}</span>
    </div>
  `).join('')
  let footerHtml = ''
  if (loading) {
    footerHtml = candidates.length === 0
      ? `<div class="autocomplete-loading"><span class="btn-spinner"></span><span>Jira에서 검색 중...</span></div>`
      : `<div class="autocomplete-footer"><span class="btn-spinner"></span><span>Jira에서 더 검색 중...</span></div>`
  }
  dropdown.innerHTML = itemsHtml + footerHtml
  dropdown.querySelectorAll('.autocomplete-item').forEach(el => {
    // mousedown은 blur보다 먼저 발생 → blur로 드롭다운 닫히기 전에 선택 처리
    el.addEventListener('mousedown', (e) => {
      e.preventDefault()
      selectKeyCandidate(ctx, el.dataset.key, el.dataset.summary || '')
    })
    el.addEventListener('mouseenter', () => {
      state[ctx.activeIdxKey] = parseInt(el.dataset.idx, 10)
      dropdown.querySelectorAll('.autocomplete-item').forEach((it, i) => {
        it.classList.toggle('active', i === state[ctx.activeIdxKey])
      })
    })
  })
}

export function selectKeyCandidate(ctx, key, summary) {
  const input = document.getElementById(ctx.inputId)
  if (!input) return
  input.value = key
  state[ctx.checkKey] = { status: 'ok', key, summary }
  renderKeyHint(ctx)
  const dropdown = document.getElementById(ctx.dropdownId)
  if (dropdown) { dropdown.style.display = 'none'; dropdown.innerHTML = '' }
  state[ctx.activeIdxKey] = -1
}

export function updateKeyDropdown(ctx) {
  const input = document.getElementById(ctx.inputId)
  if (!input) return
  const query = input.value
  if (!query.trim()) {
    renderKeyDropdown(ctx, [])
    return
  }
  const localCandidates = findLocalIssueCandidates(query)
  state[ctx.activeIdxKey] = -1

  // 이전 debounce/in-flight 요청 모두 취소 (네트워크/콜백 낭비 제거)
  clearTimeout(state[ctx.timerKey])
  if (state[ctx.controllerKey]) {
    state[ctx.controllerKey].abort()
    state[ctx.controllerKey] = null
  }

  const q = query.trim()
  if (q.length < 2) {
    renderKeyDropdown(ctx, localCandidates)
    return
  }
  // 즉시 로컬 후보 + 로딩 표시 (API 응답 대기 중)
  renderKeyDropdown(ctx, localCandidates, true)
  state[ctx.timerKey] = setTimeout(async () => {
    const controller = new AbortController()
    state[ctx.controllerKey] = controller
    try {
      const projectKeys = getProjectKeysOrFallback()
      const apiResults = await searchIssuesByKey(q, projectKeys, { signal: controller.signal })
      if (controller.signal.aborted) return
      const currentInput = document.getElementById(ctx.inputId)
      if (!currentInput || currentInput.value.trim() !== q) return
      const merged = [...localCandidates]
      for (const r of apiResults) {
        if (!merged.some(c => c.key === r.key)) {
          merged.push({ key: r.key, summary: r.summary })
        }
        if (merged.length >= 20) break
      }
      renderKeyDropdown(ctx, merged, false)
    } catch (err) {
      if (err?.name === 'AbortError') return
      console.warn('자동완성 API 실패:', err)
      const currentInput = document.getElementById(ctx.inputId)
      if (!currentInput || currentInput.value.trim() !== q) return
      renderKeyDropdown(ctx, localCandidates, false)
    } finally {
      if (state[ctx.controllerKey] === controller) state[ctx.controllerKey] = null
    }
  }, 300)
}

// 이슈 키 힌트 영역만 직접 업데이트 (모달 입력값 유지 위해 전체 리렌더 회피)
export function renderKeyHint(ctx) {
  const input = document.getElementById(ctx.inputId)
  if (!input) return
  const field = input.closest('.modal-field')
  if (!field) return
  const existing = field.querySelector('.input-hint')
  if (existing) existing.remove()
  const check = state[ctx.checkKey]
  if (!check) return
  const hint = document.createElement('div')
  hint.className = 'input-hint'
  if (check.status === 'checking') {
    hint.textContent = '확인 중...'
  } else if (check.status === 'ok') {
    hint.classList.add('ok')
    hint.textContent = `✓ ${check.summary || ''}`
  } else {
    hint.classList.add('error')
    hint.textContent = `⚠ ${check.message || ''}`
  }
  field.appendChild(hint)
}

// 기존 호출부 호환을 위한 수동 기록 모달용 얇은 래퍼
export function renderManualKeyDropdown(candidates, loading = false) {
  return renderKeyDropdown(MANUAL_KEY_CTX, candidates, loading)
}
export function selectManualKeyCandidate(key, summary) {
  return selectKeyCandidate(MANUAL_KEY_CTX, key, summary)
}
export function updateManualKeyDropdown() {
  return updateKeyDropdown(MANUAL_KEY_CTX)
}
export function renderManualKeyHint() {
  return renderKeyHint(MANUAL_KEY_CTX)
}

// ========== 소요 시간 readout ==========
// 소요 시간 readout 업데이트 (수동 로그 모달)
export function updateManualDurationReadout() {
  const startEl = document.getElementById('manual-start-time')
  const endEl = document.getElementById('manual-end-time')
  const readout = document.getElementById('manual-duration-readout')
  if (!startEl || !endEl || !readout) return
  const dur = computeDurationFromTimes(startEl.value, endEl.value)
  if (!dur.valid) {
    readout.textContent = dur.message || '-'
    readout.classList.add('error')
    return
  }
  readout.classList.remove('error')
  const main = formatMinutes(dur.actualMinutes)
  readout.textContent = dur.lunchMinutes > 0
    ? `${main} (점심시간 ${formatMinutes(dur.lunchMinutes)} 제외)`
    : main
}

// 소요 시간 readout 업데이트 (수정 모달)
export function updateEditDurationReadout() {
  const startEl = document.getElementById('edit-start-time')
  const endEl = document.getElementById('edit-end-time')
  const readout = document.getElementById('edit-duration-readout')
  if (!startEl || !endEl || !readout) return
  const dur = computeDurationFromTimes(startEl.value, endEl.value)
  if (!dur.valid) {
    readout.textContent = dur.message || '-'
    readout.classList.add('error')
    return
  }
  readout.classList.remove('error')
  const main = formatMinutes(dur.actualMinutes)
  readout.textContent = dur.lunchMinutes > 0
    ? `${main} (점심시간 ${formatMinutes(dur.lunchMinutes)} 제외)`
    : main
}

// 시작/종료 시간(HH:MM)으로부터 점심시간 차감된 실제 소요(분) 계산
// 반환: { totalMinutes, lunchMinutes, actualMinutes, valid, message }
export function computeDurationFromTimes(startTime, endTime) {
  if (!startTime || !endTime) return { valid: false, message: '시간을 입력해주세요.' }
  const [sh, sm] = startTime.split(':').map(Number)
  const [eh, em] = endTime.split(':').map(Number)
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  if (endMin <= startMin) return { valid: false, message: '종료 시간은 시작 시간보다 이후여야 합니다.' }
  const totalMinutes = endMin - startMin
  const lunchMinutes = Math.max(0, Math.min(endMin, LUNCH_END) - Math.max(startMin, LUNCH_START))
  const actualMinutes = Math.max(0, totalMinutes - lunchMinutes)
  if (actualMinutes <= 0) return { valid: false, message: '점심시간을 제외하면 실제 작업 시간이 없습니다.' }
  return { valid: true, totalMinutes, lunchMinutes, actualMinutes }
}

// ========== 이슈 상세 모달 ==========
// 목록에서 행 클릭 시 열림. 기본 정보는 목록 데이터로 즉시 표시하고
// 설명/첨부/스프린트/추정치 등 상세 필드는 비동기로 로드.
export function renderIssueDetailModal() {
  const m = state.issueDetailModal
  if (!m) return ''

  const d = m.data || {}
  const listIssue = findLoadedIssue(m.key) || {}
  const key = m.key
  const summary = d.summary || listIssue.summary || ''
  const type = d.type || listIssue.type || ''
  const typeIconUrl = d.typeIconUrl || listIssue.typeIconUrl || ''
  const priority = d.priority || listIssue.priority || ''
  const priorityIconUrl = d.priorityIconUrl || listIssue.priorityIconUrl || ''
  const status = d.status || listIssue.status || ''
  const statusCategory = d.statusCategory || listIssue.statusCategory || 'new'
  const statusCss = getStatusCss(statusCategory || status)
  const statusLabel = getShortStatusLabel(status)
  const assignee = d.assignee || listIssue.assignee || null
  const reporter = d.reporter || null

  const siteName = localStorage.getItem('jira_site_name')
  const jiraUrl = siteName ? `https://${siteName}.atlassian.net/browse/${key}` : null

  // 타입 아이콘은 클릭하여 유형 변경 가능. 변경 진행 중이면 스피너로 대체.
  const isTypeUpdating = state.typeUpdating.has(key)
  const typeIconInner = typeIconUrl
    ? `<img class="detail-type-icon" src="${escapeHtml(typeIconUrl)}" alt="${escapeHtml(type)}" />`
    : `<span class="detail-type-icon detail-type-icon-empty"></span>`
  const typeBtnHtml = isTypeUpdating
    ? `<button type="button" class="detail-type-btn is-loading" disabled aria-label="유형 변경 중"><span class="btn-spinner"></span></button>`
    : `<button type="button" class="detail-type-btn" data-action="toggle-type-menu" data-key="${escapeHtml(key)}" data-current-type="${escapeHtml(type)}" title="${escapeHtml(type)} · 클릭하여 유형 변경">${typeIconInner}</button>`

  const priorityIconHtml = priorityIconUrl
    ? `<img class="detail-priority-icon" src="${escapeHtml(priorityIconUrl)}" alt="${escapeHtml(priority)}" />`
    : ''

  // 상태: 클릭하면 status dropdown. 전이 중이면 스피너.
  const isStatusTransitioning = state.statusTransitioning.has(key)
  const statusBtnHtml = isStatusTransitioning
    ? `<button type="button" class="issue-status ${statusCss} is-loading" disabled aria-label="상태 변경 중"><span class="btn-spinner"></span></button>`
    : `<button type="button" class="issue-status ${statusCss}" data-action="toggle-status-menu" data-key="${escapeHtml(key)}" data-current-status="${escapeHtml(status || '')}" title="${escapeHtml(status || '-')} · 클릭하여 상태 변경">${escapeHtml(statusLabel || status || '-')}</button>`

  // 담당자/보고자 렌더링. assignee는 클릭 시 변경 가능, reporter는 표시만.
  const renderPerson = (p, fallback) => {
    if (!p) return `<span class="detail-meta-empty">${fallback}</span>`
    const avatar = p.avatarUrl
      ? `<img class="detail-avatar" src="${escapeHtml(p.avatarUrl)}" alt="${escapeHtml(p.displayName)}" onerror="this.classList.add('broken')" />`
      : `<span class="detail-avatar detail-avatar-empty"></span>`
    return `${avatar}<span>${escapeHtml(p.displayName)}</span>`
  }

  // 담당자: 클릭 시 변경 드롭다운. 변경 중이면 스피너.
  const isAssigneeUpdating = state.assigneeUpdating.has(key)
  const assigneeBtnHtml = (() => {
    if (isAssigneeUpdating) {
      return `<span class="detail-assignee-btn is-loading" aria-label="담당자 변경 중"><span class="btn-spinner"></span><span>변경 중…</span></span>`
    }
    const inner = assignee
      ? renderPerson(assignee, '미할당')
      : `<span class="detail-avatar detail-avatar-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6"/></svg>
        </span><span class="detail-meta-empty">미할당</span>`
    return `<button type="button" class="detail-assignee-btn" data-action="toggle-assignee-menu" data-issue-key="${escapeHtml(key)}" title="클릭하여 담당자 변경">${inner}</button>`
  })()

  const sprintHtml = (() => {
    if (m.loading && !d.sprints) return `<span class="detail-meta-empty">불러오는 중…</span>`
    if (!d.sprints || d.sprints.length === 0) return `<span class="detail-meta-empty">-</span>`
    return d.sprints.map(s => `<span class="detail-sprint-chip ${s.state}">${escapeHtml(s.name)}</span>`).join(' ')
  })()

  const dueHtml = (() => {
    if (m.loading && !d.duedate) return `<span class="detail-meta-empty">불러오는 중…</span>`
    if (!d.duedate) return `<span class="detail-meta-empty">-</span>`
    return escapeHtml(d.duedate)
  })()

  const estHtml = (m.loading && !d.originalEstimate) ? '불러오는 중…' : (d.originalEstimate || '-')
  const spentHtml = (m.loading && !d.timeSpent) ? '불러오는 중…' : (d.timeSpent || '-')

  const descriptionSection = (() => {
    if (m.loading && !d.descriptionAdf && !d.attachments) {
      return `<div class="detail-loading"><div class="loading-spinner"></div><span>상세 정보를 불러오는 중</span></div>`
    }
    if (m.error) {
      return `<div class="detail-error">상세 정보를 불러오지 못했습니다: ${escapeHtml(m.error)}</div>`
    }

    const attachmentsHtml = (d.attachments && d.attachments.length > 0)
      ? `
        <div class="detail-section-label">첨부파일 (${d.attachments.length})</div>
        <div class="detail-attachments">
          ${d.attachments.map(a => renderAttachmentTile(a)).join('')}
        </div>
      `
      : ''

    // 편집 모드: 저장 중에도 에디터를 그대로 두고 setEditable(false)로만 잠근다
    if (m.editing) {
      const lossyWarn = (m.lossyFeatures && m.lossyFeatures.length > 0)
        ? `<div class="detail-edit-warn">⚠ 이 이슈의 설명에는 에디터가 지원하지 않는 요소(${escapeHtml(m.lossyFeatures.join(', '))})가 있어, 저장 시 해당 요소가 텍스트로 변환되거나 제거됩니다. 복잡한 편집은 Jira에서 진행하세요.</div>`
        : ''
      const saveErrHtml = m.saveError
        ? `<div class="detail-edit-error">저장 실패: ${escapeHtml(m.saveError)}</div>`
        : ''
      const savingClass = m.saving ? ' is-saving' : ''
      return `
        ${lossyWarn}
        ${renderTiptapToolbar()}
        <div class="tiptap-editor-mount${savingClass}" id="issue-detail-edit-editor"></div>
        ${saveErrHtml}
        ${attachmentsHtml}
      `
    }

    // 보기 모드: ADF → HTML
    const attachmentsById = {}
    for (const a of (d.attachments || [])) attachmentsById[a.id] = a
    const rendered = d.descriptionAdf ? renderAdf(d.descriptionAdf, { attachmentsById }) : ''

    const descHtml = rendered
      ? `<div class="detail-description" id="issue-detail-description" title="클릭하여 편집">${rendered}</div>`
      : `<div class="detail-description detail-description-empty" id="issue-detail-description" title="클릭하여 편집">(설명 없음 — 클릭하여 추가)</div>`
    return `${descHtml}${attachmentsHtml}`
  })()

  const openJiraBtn = jiraUrl
    ? `<a class="btn" href="${jiraUrl}" target="_blank" rel="noopener noreferrer">Jira에서 열기</a>`
    : ''

  const footerHtml = m.editing
    ? `
      ${openJiraBtn}
      <button class="btn" id="issue-detail-edit-cancel" ${m.saving ? 'disabled' : ''}>취소</button>
      <button class="btn btn-primary" id="issue-detail-edit-save" ${m.saving ? 'disabled' : ''}>
        ${m.saving ? '<span class="btn-spinner"></span> 저장 중…' : '저장'}
      </button>
    `
    : `
      ${openJiraBtn}
      <button class="btn btn-primary" id="issue-detail-close-footer">닫기</button>
    `

  return `
    <div class="modal-overlay" id="issue-detail-overlay">
      <div class="modal modal-issue-detail">
        <div class="detail-header">
          <div class="detail-header-left">
            ${typeBtnHtml}
            <span class="detail-type-label">${escapeHtml(type)}</span>
            <a class="issue-key issue-key-link" href="${jiraUrl || '#'}" target="_blank" rel="noopener noreferrer">${escapeHtml(key)}</a>
          </div>
          <button class="detail-close" id="issue-detail-close" aria-label="닫기">✕</button>
        </div>
        ${renderDetailSummary(m, summary)}
        <div class="detail-meta-grid">
          <div class="detail-meta-row"><span class="detail-meta-label">상태</span><span class="detail-meta-value">${statusBtnHtml}</span></div>
          <div class="detail-meta-row"><span class="detail-meta-label">우선순위</span><span class="detail-meta-value">${priorityIconHtml}${escapeHtml(priority || '-')}</span></div>
          <div class="detail-meta-row"><span class="detail-meta-label">담당자</span><span class="detail-meta-value detail-person">${assigneeBtnHtml}</span></div>
          <div class="detail-meta-row"><span class="detail-meta-label">보고자</span><span class="detail-meta-value detail-person">${renderPerson(reporter, m.loading ? '불러오는 중…' : '-')}</span></div>
          <div class="detail-meta-row"><span class="detail-meta-label">스프린트</span><span class="detail-meta-value">${sprintHtml}</span></div>
          <div class="detail-meta-row"><span class="detail-meta-label">기한</span><span class="detail-meta-value">${dueHtml}</span></div>
          <div class="detail-meta-row"><span class="detail-meta-label">최초 추정치</span><span class="detail-meta-value">${escapeHtml(estHtml)}</span></div>
          <div class="detail-meta-row"><span class="detail-meta-label">진행 시간</span><span class="detail-meta-value">${escapeHtml(spentHtml)}</span></div>
        </div>
        <div class="detail-body">
          ${descriptionSection}
          ${renderDetailComments(m, key)}
        </div>
        <div class="detail-footer">
          ${footerHtml}
        </div>
      </div>
    </div>
  `
}

// ========== 댓글 영역 ==========
// 본문과 동일한 tiptap 에디터로 작성/수정 → 멘션·이미지·표 등 풍부한 마크업 보존.
// 본인 작성 댓글에만 수정/삭제 버튼 노출 (myself accountId 비교).
function renderDetailComments(m, issueKey) {
  // 상세 본문이 아직 로딩 중이면 비워둠 (descriptionSection이 로딩 표시 중)
  if (m.loading && !m.data?.comments) return ''
  if (m.error) return ''

  const comments = m.data?.comments || []
  const myAccountId = getCachedMyself()?.accountId || ''
  // 댓글 본문 안의 미디어/첨부 노드는 이슈 attachments에서 해석
  const attachmentsById = {}
  for (const a of (m.data?.attachments || [])) attachmentsById[a.id] = a

  const itemsHtml = comments.length === 0
    ? `<div class="detail-comment-empty">아직 댓글이 없습니다.</div>`
    : comments.map(c => renderCommentItem(c, m, myAccountId, attachmentsById)).join('')

  return `
    <div class="detail-comments">
      <div class="detail-section-label detail-comments-header">댓글 ${comments.length}</div>
      <div class="detail-comments-list">
        ${itemsHtml}
      </div>
      ${renderCommentCompose(m)}
    </div>
  `
}

function renderCommentCompose(m) {
  const submitting = !!m.commentSubmitting
  const composeError = !m.editingCommentId && m.commentError
    ? `<div class="detail-comment-error">${escapeHtml(m.commentError)}</div>`
    : ''
  if (!m.commentComposeOpen) {
    return `
      <div class="detail-comment-compose detail-comment-compose-collapsed">
        <button class="detail-comment-compose-trigger" id="detail-comment-compose-open">
          댓글을 입력하세요...
        </button>
      </div>
    `
  }
  return `
    <div class="detail-comment-compose detail-comment-compose-open${submitting ? ' is-saving' : ''}">
      ${renderTiptapToolbar('detail-comment-compose-toolbar', 'detail-comment-compose-editor')}
      <div class="tiptap-editor-mount detail-comment-editor-mount" id="detail-comment-compose-editor"></div>
      ${composeError}
      <div class="detail-comment-compose-actions">
        <button class="btn btn-sm" id="detail-comment-compose-cancel" ${submitting ? 'disabled' : ''}>취소</button>
        <button class="btn btn-primary btn-sm" id="detail-comment-submit" ${submitting ? 'disabled' : ''}>
          ${submitting ? '<span class="btn-spinner"></span> 작성 중…' : '댓글 작성'}
        </button>
      </div>
    </div>
  `
}

function renderCommentItem(c, m, myAccountId, attachmentsById) {
  const isMine = !!c.author?.accountId && c.author.accountId === myAccountId
  const isEditing = m.editingCommentId === c.id
  const isDeleting = m.deletingCommentId === c.id
  const editingSaving = isEditing && !!m.editingCommentSaving
  const editError = isEditing && m.commentError ? m.commentError : ''
  const edited = c.updated && c.updated !== c.created

  const avatar = c.author?.avatarUrl
    ? `<img class="detail-comment-avatar" src="${escapeHtml(c.author.avatarUrl)}" alt="${escapeHtml(c.author.displayName)}" onerror="this.classList.add('broken')" />`
    : `<span class="detail-comment-avatar detail-comment-avatar-empty"></span>`

  const meta = `
    <span class="detail-comment-author">${escapeHtml(c.author?.displayName || '')}</span>
    <span class="detail-comment-time">${escapeHtml(formatCommentTime(c.created))}${edited ? ' · 수정됨' : ''}</span>
  `

  const actions = isMine && !isEditing && !isDeleting
    ? `
      <div class="detail-comment-actions">
        <button class="btn-link" data-action="edit-comment" data-comment-id="${escapeHtml(c.id)}">수정</button>
        <button class="btn-link btn-link-danger" data-action="delete-comment" data-comment-id="${escapeHtml(c.id)}">삭제</button>
      </div>
    `
    : ''

  const safeId = escapeHtml(c.id)
  const editorMountId = `detail-comment-edit-editor-${safeId}`
  const editorToolbarId = `detail-comment-edit-toolbar-${safeId}`

  const body = isEditing
    ? `
      <div class="detail-comment-edit${editingSaving ? ' is-saving' : ''}">
        ${renderTiptapToolbar(editorToolbarId, editorMountId)}
        <div class="tiptap-editor-mount detail-comment-editor-mount" id="${editorMountId}"></div>
        ${editError ? `<div class="detail-comment-error">${escapeHtml(editError)}</div>` : ''}
        <div class="detail-comment-edit-actions">
          <button class="btn btn-sm" data-action="cancel-edit-comment" ${editingSaving ? 'disabled' : ''}>취소</button>
          <button class="btn btn-primary btn-sm" data-action="save-edit-comment" data-comment-id="${safeId}" ${editingSaving ? 'disabled' : ''}>
            ${editingSaving ? '<span class="btn-spinner"></span> 저장 중…' : '저장'}
          </button>
        </div>
      </div>
    `
    : `<div class="detail-comment-body">${c.bodyAdf ? renderAdf(c.bodyAdf, { attachmentsById }) : ''}</div>`

  const deleteConfirm = isDeleting
    ? `
      <div class="detail-comment-delete-confirm">
        <span>이 댓글을 삭제하시겠습니까?</span>
        <button class="btn btn-sm" data-action="cancel-delete-comment" ${m.commentSubmitting ? 'disabled' : ''}>취소</button>
        <button class="btn btn-danger btn-sm" data-action="confirm-delete-comment" data-comment-id="${safeId}" ${m.commentSubmitting ? 'disabled' : ''}>
          ${m.commentSubmitting ? '<span class="btn-spinner"></span> 삭제 중…' : '삭제'}
        </button>
      </div>
    `
    : ''

  return `
    <div class="detail-comment" data-comment-id="${safeId}">
      ${avatar}
      <div class="detail-comment-main">
        <div class="detail-comment-head">
          ${meta}
          ${actions}
        </div>
        ${body}
        ${deleteConfirm}
      </div>
    </div>
  `
}

// 'YYYY-MM-DDTHH:MM:SS.sss+ZZZZ' → 'YYYY-MM-DD HH:MM' (로컬)
function formatCommentTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 요약 영역. 보기 모드에서는 클릭 시 인라인 편집 모드로 전환.
// 저장 버튼은 인라인 input 바로 아래에 두고 Enter=저장, Esc=취소.
function renderDetailSummary(m, summary) {
  if (!m.summaryEditing) {
    return `<div class="detail-summary" id="issue-detail-summary" title="클릭하여 편집">${escapeHtml(summary)}</div>`
  }
  const draft = m.summaryDraft != null ? m.summaryDraft : summary
  const saving = !!m.summarySaving
  const errHtml = m.summaryError
    ? `<div class="detail-summary-error">저장 실패: ${escapeHtml(m.summaryError)}</div>`
    : ''
  return `
    <div class="detail-summary-edit">
      <input type="text" id="issue-detail-summary-input" class="detail-summary-input"
        value="${escapeHtml(draft)}" maxlength="255" ${saving ? 'disabled' : ''} />
      <div class="detail-summary-actions">
        <button class="btn" id="issue-detail-summary-cancel" ${saving ? 'disabled' : ''}>취소</button>
        <button class="btn btn-primary" id="issue-detail-summary-save" ${saving ? 'disabled' : ''}>
          ${saving ? '<span class="btn-spinner"></span> 저장 중…' : '저장'}
        </button>
      </div>
      ${errHtml}
    </div>
  `
}

// 일반화된 tiptap 툴바. 어느 mount element를 조작하는지 data 속성으로 표시.
// 본문 편집/댓글 작성/댓글 편집 모두 같은 디자인 재사용.
export function renderTiptapToolbar(toolbarId = 'issue-detail-edit-toolbar', mountId = 'issue-detail-edit-editor') {
  const btn = (cmd, label, title, args = '') =>
    `<button type="button" class="tiptap-tb-btn" data-tt-cmd="${cmd}"${args ? ` data-tt-args='${args}'` : ''} title="${title}">${label}</button>`
  return `
    <div class="tiptap-toolbar" id="${toolbarId}" data-tt-mount-id="${mountId}">
      ${btn('toggleBold', '<b>B</b>', '굵게 (Ctrl+B)')}
      ${btn('toggleItalic', '<i>I</i>', '이탤릭 (Ctrl+I)')}
      ${btn('toggleStrike', '<span style="text-decoration:line-through">S</span>', '취소선 (Ctrl+Shift+X)')}
      ${btn('toggleCode', '<code>&lt;&gt;</code>', '인라인 코드 (Ctrl+E)')}
      <span class="tiptap-tb-sep"></span>
      ${btn('setHeading', 'H1', '제목 1', JSON.stringify({ level: 1 }))}
      ${btn('setHeading', 'H2', '제목 2', JSON.stringify({ level: 2 }))}
      ${btn('setHeading', 'H3', '제목 3', JSON.stringify({ level: 3 }))}
      ${btn('setParagraph', 'P', '본문 문단')}
      <span class="tiptap-tb-sep"></span>
      ${btn('toggleBulletList', '•', '불릿 목록')}
      ${btn('toggleOrderedList', '1.', '번호 목록')}
      ${btn('toggleBlockquote', '❝', '인용')}
      ${btn('toggleCodeBlock', '{ }', '코드 블록')}
      ${btn('setHorizontalRule', '―', '구분선')}
      <span class="tiptap-tb-sep"></span>
      <button type="button" class="tiptap-tb-btn" data-tt-cmd="__link" title="링크 (Ctrl+K)">🔗</button>
      <button type="button" class="tiptap-tb-btn" data-tt-cmd="unsetLink" title="링크 제거">🔗✕</button>
      <span class="tiptap-tb-sep"></span>
      ${btn('undo', '↶', '실행 취소 (Ctrl+Z)')}
      ${btn('redo', '↷', '다시 실행 (Ctrl+Shift+Z)')}
    </div>
  `
}

function renderAttachmentTile(a) {
  const fn = escapeHtml(a.filename || '')
  const isImage = (a.mimeType || '').startsWith('image/')
  const sizeKb = a.size ? `${Math.max(1, Math.round(a.size / 1024))}KB` : ''
  const dataUrl = escapeHtml(a.contentUrl || '')
  if (isImage) {
    return `
      <a class="detail-attachment detail-attachment-image" data-attachment-url="${dataUrl}" href="#" title="${fn}">
        <span class="detail-attachment-thumb" data-thumb-url="${escapeHtml(a.thumbnailUrl || a.contentUrl || '')}"></span>
        <span class="detail-attachment-name">${fn}</span>
      </a>
    `
  }
  return `
    <a class="detail-attachment detail-attachment-file" data-attachment-url="${dataUrl}" href="#" title="${fn}">
      <span class="detail-attachment-icon">📄</span>
      <span class="detail-attachment-name">${fn}</span>
      ${sizeKb ? `<span class="detail-attachment-size">${sizeKb}</span>` : ''}
    </a>
  `
}
