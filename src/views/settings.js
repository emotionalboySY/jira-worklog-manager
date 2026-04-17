// 설정 FAB 버튼 + 설정 모달 (정렬 순서, 프로젝트 색상)
import { state, DEFAULT_PROJECT_COLORS } from '../state.js'

// 우측 하단 설정 플로팅 버튼
export function renderSettingsFab() {
  return `
    <button class="settings-fab" id="btn-open-settings" title="설정">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    </button>
  `
}

export function renderSettingsModal() {
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
        <div class="modal-title">설정</div>

        <div class="modal-section-label">이슈 상태 정렬 순서</div>
        <div class="settings-hint">위에 있을수록 이슈 목록 상단에 표시됩니다.</div>
        <div class="settings-order-list">${statusItems}</div>

        <div class="modal-section-label" style="margin-top:20px;">프로젝트 정렬 · 색상</div>
        <div class="settings-hint">각 프로젝트의 정렬 순서와 대표 색상(컬러 바, 이슈 키 배지 호버 배경)을 조정합니다.</div>
        <div class="settings-order-list">${projectItems}</div>

        <div class="settings-note">
          ℹ️ 상태와 프로젝트로 정렬한 뒤, 같은 그룹 안에서는 <strong>이슈 번호 내림차순</strong>으로 고정 정렬됩니다.
        </div>

        <div class="modal-actions settings-actions">
          <button class="btn btn-sm" id="settings-reset">기본값으로 재설정</button>
          <div class="settings-actions-right">
            <button class="btn" id="settings-cancel">취소</button>
            <button class="btn btn-primary" id="settings-save">저장</button>
          </div>
        </div>
      </div>
    </div>
  `
}
