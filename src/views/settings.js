// 설정 FAB 버튼 + 서브메뉴 + 설정 모달 3종 (이슈 목록 / 전역 / 공휴일)
import { state, DEFAULT_PROJECT_COLORS, LUNCH_START, LUNCH_END } from '../state.js'
import { formatHHMM, escapeHtml, closeIconSvg } from '../utils.js'

const WIDGET_DOWNLOAD_URL = 'https://github.com/emotionalboySY/jira-worklog-widget-releases/releases/latest'

// 서브메뉴 아이콘 (feather 스타일, currentColor stroke)
const ICON_LIST = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`
const ICON_SLIDERS = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>`
const ICON_DOWNLOAD = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`
const ICON_CALENDAR = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`

// 좌측 하단 설정 플로팅 버튼 + 클릭 시 위로 펼쳐지는 서브메뉴
export function renderSettingsFab() {
  const menuOpen = state.showSettingsMenu
  const active = menuOpen || !!state.showSettings
  const menu = menuOpen ? `
    <div class="settings-fab-menu" id="settings-fab-menu" role="menu" aria-label="설정 메뉴">
      <button class="settings-sub-fab" data-settings-open="issues" role="menuitem" aria-label="이슈 목록 설정">
        ${ICON_LIST}<span class="settings-sub-fab-label">이슈 목록 설정</span>
      </button>
      <button class="settings-sub-fab" data-settings-open="global" role="menuitem" aria-label="전역 설정">
        ${ICON_SLIDERS}<span class="settings-sub-fab-label">전역 설정</span>
      </button>
      <a class="settings-sub-fab" id="settings-widget-download" href="${WIDGET_DOWNLOAD_URL}" target="_blank" rel="noopener" role="menuitem" aria-label="위젯 다운로드 (Windows)">
        ${ICON_DOWNLOAD}<span class="settings-sub-fab-label">위젯 다운로드 (Windows)</span>
      </a>
      <button class="settings-sub-fab" data-settings-open="holidays" role="menuitem" aria-label="공휴일 설정">
        ${ICON_CALENDAR}<span class="settings-sub-fab-label">공휴일 설정</span>
      </button>
    </div>
  ` : ''
  return `
    ${menu}
    <button class="settings-fab ${active ? 'is-open' : ''}" id="btn-open-settings" aria-expanded="${menuOpen}" aria-haspopup="menu" title="${active ? '설정 닫기' : '설정'}">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    </button>
  `
}

// 열린 설정 모달 종류에 따라 분기 (render.js가 state.showSettings truthy일 때 호출)
export function renderSettingsModal() {
  if (state.showSettings === 'issues') return renderIssueListSettingsModal()
  if (state.showSettings === 'global') return renderGlobalSettingsModal()
  if (state.showSettings === 'holidays') return renderHolidaySettingsModal()
  return ''
}

// 공통 하단 액션 (재설정/취소/저장) — 세 모달이 같은 id를 공유(동시에 하나만 열림)
function renderSettingsActions(resetLabel) {
  return `
    <div class="modal-actions settings-actions">
      <button class="btn btn-sm" id="settings-reset">${resetLabel}</button>
      <div class="settings-actions-right">
        <button class="btn" id="settings-cancel">취소</button>
        <button class="btn btn-primary" id="settings-save">저장</button>
      </div>
    </div>
  `
}

// ========== 이슈 목록 설정 (상태 정렬 / 프로젝트 정렬·색상) ==========
function renderIssueListSettingsModal() {
  const draft = state.settingsDraft
  if (!draft) return ''

  const statusItems = draft.statusOrder.map((s, i) => `
    <div class="settings-order-item" data-kind="status" data-idx="${i}">
      <span class="settings-drag-handle" title="드래그하여 순서 변경">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="4" width="18" height="2.5" rx="1"/><rect x="3" y="10.75" width="18" height="2.5" rx="1"/><rect x="3" y="17.5" width="18" height="2.5" rx="1"/></svg>
      </span>
      <span class="settings-order-index">${i + 1}</span>
      <span class="settings-order-label">${s}</span>
    </div>
  `).join('')

  const projectItems = draft.projectOrder.map((p, i) => {
    const color = draft.projectColors[p]?.bar || DEFAULT_PROJECT_COLORS[p]?.bar || '#6366f1'
    return `
      <div class="settings-order-item" data-kind="project" data-idx="${i}">
        <span class="settings-drag-handle" title="드래그하여 순서 변경">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="4" width="18" height="2.5" rx="1"/><rect x="3" y="10.75" width="18" height="2.5" rx="1"/><rect x="3" y="17.5" width="18" height="2.5" rx="1"/></svg>
        </span>
        <span class="settings-order-index">${i + 1}</span>
        <span class="settings-project-swatch" style="background: ${color}"></span>
        <span class="settings-order-label">${p}</span>
        <input type="color" class="settings-color-input" data-project-color="${p}" value="${color}" title="${p} 대표 색상 변경" />
      </div>
    `
  }).join('')

  return `
    <div class="modal-overlay" id="settings-overlay">
      <div class="modal modal-settings">
        <div class="modal-title">이슈 목록 설정</div>

        <div class="modal-section-label">이슈 상태 정렬 순서</div>
        <div class="settings-hint">위에 있을수록 이슈 목록 상단에 표시됩니다.</div>
        <div class="settings-order-list">${statusItems}</div>

        <div class="modal-section-label" style="margin-top:20px;">프로젝트 정렬 · 색상</div>
        <div class="settings-hint">각 프로젝트의 정렬 순서와 대표 색상(컬러 바, 이슈 키 배지 호버 배경)을 조정합니다.</div>
        <div class="settings-order-list">${projectItems}</div>

        <div class="settings-note">
          ℹ️ 상태와 프로젝트로 정렬한 뒤, 같은 그룹 안에서는 <strong>이슈 번호 내림차순</strong>으로 고정 정렬됩니다.
        </div>

        ${renderSettingsActions('기본값으로 재설정')}
      </div>
    </div>
  `
}

// ========== 전역 설정 (주 시작 요일 / 기본 점심시간) ==========
function renderGlobalSettingsModal() {
  const draft = state.settingsDraft
  if (!draft) return ''

  return `
    <div class="modal-overlay" id="settings-overlay">
      <div class="modal modal-settings">
        <div class="modal-title">전역 설정</div>

        <div class="modal-section-label">요약 탭 주 시작 요일</div>
        <div class="settings-hint">요약 탭에서 한 주의 시작 요일을 선택합니다. 주차 번호는 ISO 기준(해당 주 목요일이 속한 달)으로 일관 유지됩니다.</div>
        <div class="settings-segmented" role="radiogroup" aria-label="주 시작 요일">
          <button type="button" class="settings-segmented-btn ${draft.summaryWeekStart === 'thursday' ? 'active' : ''}" role="radio" aria-checked="${draft.summaryWeekStart === 'thursday'}" data-week-start="thursday">목요일 ~ 수요일</button>
          <button type="button" class="settings-segmented-btn ${draft.summaryWeekStart === 'monday' ? 'active' : ''}" role="radio" aria-checked="${draft.summaryWeekStart === 'monday'}" data-week-start="monday">월요일 ~ 일요일</button>
        </div>

        <div class="modal-section-label" style="margin-top:20px;">기본 점심시간</div>
        <div class="settings-hint">자동 기록·세션 종료·수동 기록 시 이 시간대와 겹치는 만큼 자동으로 차감됩니다. 특정 날만 다르면(예: 행사·경기 시청) 각 기록 모달에서 그날만 즉석으로 바꿀 수 있습니다.</div>
        <div class="lunch-row settings-lunch-row">
          <input type="time" class="modal-input settings-lunch-start" value="${formatHHMM(draft.lunchStart ?? LUNCH_START)}" aria-label="기본 점심 시작 시간" />
          <span class="lunch-tilde">~</span>
          <input type="time" class="modal-input settings-lunch-end" value="${formatHHMM(draft.lunchEnd ?? LUNCH_END)}" aria-label="기본 점심 종료 시간" />
        </div>

        ${renderSettingsActions('기본값으로 재설정')}
      </div>
    </div>
  `
}

// ========== 공휴일 설정 ==========
const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토']

function renderHolidaySettingsModal() {
  const draft = state.holidaysDraft
  if (!draft) return ''

  // 연도별 그룹 (draft는 날짜 오름차순 정렬 유지 — data-idx는 draft 배열 인덱스)
  const byYear = new Map()
  draft.forEach((h, idx) => {
    const year = h.date.slice(0, 4)
    if (!byYear.has(year)) byYear.set(year, [])
    byYear.get(year).push({ ...h, idx })
  })

  const yearSections = [...byYear.entries()].map(([year, items]) => `
    <div class="holiday-year-label">${year}년</div>
    <div class="holiday-list">
      ${items.map(h => {
        const dow = WEEKDAY_KO[new Date(h.date + 'T00:00:00').getDay()]
        return `
          <div class="holiday-item">
            <span class="holiday-date">${h.date.slice(5, 7)}-${h.date.slice(8, 10)} (${dow})</span>
            <input type="text" class="modal-input holiday-name-input" data-holiday-idx="${h.idx}" value="${escapeHtml(h.name)}" aria-label="${h.date} 공휴일 이름" />
            <button class="holiday-remove" data-holiday-remove="${h.idx}" aria-label="${h.date} 공휴일 삭제" title="삭제">${closeIconSvg(11)}</button>
          </div>
        `
      }).join('')}
    </div>
  `).join('')

  return `
    <div class="modal-overlay" id="settings-overlay">
      <div class="modal modal-settings modal-holidays">
        <div class="modal-title">공휴일 설정</div>

        <div class="settings-hint">작업 로그 달력과 요약 차트에 표시되는 공휴일 목록입니다. 기본 제공 공휴일도 이름을 고치거나 삭제할 수 있고, 회사 창립기념일 같은 휴일을 직접 추가할 수도 있어요.</div>

        <div class="holiday-add-row">
          <input type="date" class="modal-input holiday-add-date" id="holiday-add-date" aria-label="추가할 날짜" />
          <input type="text" class="modal-input holiday-add-name" id="holiday-add-name" placeholder="공휴일 이름 (예: 창립기념일)" aria-label="추가할 공휴일 이름" />
          <button class="btn btn-sm" id="holiday-add-btn">추가</button>
        </div>

        ${yearSections || '<div class="settings-hint" style="margin-top:12px;">등록된 공휴일이 없습니다.</div>'}

        <div class="settings-note">
          ℹ️ 변경 사항은 <strong>저장</strong>을 눌러야 적용되며, 이 브라우저에만 저장됩니다.
        </div>

        ${renderSettingsActions('기본 공휴일로 재설정')}
      </div>
    </div>
  `
}
