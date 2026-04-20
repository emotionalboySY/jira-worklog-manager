// 모든 모달 + 이슈 키 자동완성 관련 로직
import { state, ISSUE_KEY_PATTERN, LUNCH_START, LUNCH_END, WORKLOG_CACHE_KEY, NO_ISSUE_KEY, NO_ISSUE_SUMMARY } from '../state.js'
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
} from '../utils.js'
import { loadWorklogs } from '../data.js'

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

  // 진행 중 세션이면 마지막 구간 닫아서 계산
  const details = getSegmentDetails(session)
  const totalActual = details.reduce((sum, d) => sum + d.actualMinutes, 0)

  const fmtTime = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

  const isIssueless = session.issueKey === NO_ISSUE_KEY

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
      </div>
    `
  }

  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal">
        <div class="modal-title">작업 종료</div>
        ${issueBlockHtml}
        <div class="modal-section-label">작업 구간 (${details.length}건)</div>
        ${details.map((seg, i) => `
          <div class="modal-info">
            <span class="modal-info-label">${fmtTime(seg.start)} → ${fmtTime(seg.end)}</span>
            <span class="modal-info-value">${formatMinutes(seg.durationMinutes)}${seg.lunchMinutes > 0 ? ` <span class="deducted">(-${formatMinutes(seg.lunchMinutes)} 점심)</span>` : ''}</span>
          </div>
        `).join('')}
        <div class="modal-info" style="border-top: 1px solid var(--border); margin-top: 4px; padding-top: 12px;">
          <span class="modal-info-label">실 작업 시간 합계</span>
          <span class="modal-info-value">${formatMinutes(totalActual)}</span>
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
      state[ctx.activeIdxKey] = parseInt(el.dataset.idx)
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
      const projectKeys = (state.realProjects && state.realProjects.length)
        ? state.realProjects.map(p => p.key)
        : ['DK', 'DKT', 'DD', 'RM']
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
