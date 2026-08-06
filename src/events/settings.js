// 설정 FAB 서브메뉴 + 설정 모달 3종(이슈 목록/전역/공휴일) — 열기/닫기, 저장/재설정,
// 주 시작 요일, 프로젝트 색상, 기본 점심시간, 드래그 앤 드롭 정렬, 공휴일 편집.
import {
  state,
  DEFAULT_STATUS_ORDER,
  DEFAULT_PROJECT_ORDER,
  DEFAULT_PROJECT_COLORS,
  DEFAULT_SUMMARY_WEEK_START,
  LUNCH_START,
  LUNCH_END,
} from '../state.js'
import { savePreferences } from '../storage.js'
import { applyPreferences, showToast } from '../ui.js'
import { parseHHMM } from '../utils.js'
import { getEffectiveHolidays, getBaseHolidays, saveHolidaysFromList } from '../holidays.js'
import { render } from '../render.js'
import { on } from './_dom.js'

// 저장 전이라면 실제 적용된 prefs(state.userPrefs)로 CSS 변수 되돌림 (미리보기 롤백)
export function closeSettings() {
  applyPreferences(state.userPrefs)
  state.showSettings = null
  state.settingsDraft = null
  state.holidaysDraft = null
  state.showSettingsMenu = false
  render({ sections: ['modals', 'settings-fab'] })
}

// 공휴일 맵 → 날짜 오름차순 [{ date, name }] (draft 형태)
function holidayMapToList(map) {
  return Object.entries(map)
    .map(([date, name]) => ({ date, name }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

// 서브메뉴에서 항목 선택 → 해당 설정 모달 열기
function openSettingsModal(kind) {
  state.showSettingsMenu = false
  state.showSettings = kind
  if (kind === 'holidays') {
    state.holidaysDraft = holidayMapToList(getEffectiveHolidays())
  } else {
    state.settingsDraft = JSON.parse(JSON.stringify(state.userPrefs))
  }
  render({ sections: ['modals', 'settings-fab'] })
}

function hexToRgb(hex) {
  const h = (hex || '').replace('#', '')
  if (h.length !== 6) return { r: 99, g: 102, b: 241 } // accent 기본
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  }
}

// base hex → { bar, fg, bg } 파생. fg는 white에 30% 섞어 밝게, bg는 opacity 0.14
export function deriveProjectColors(hex) {
  const { r, g, b } = hexToRgb(hex)
  const mix = (c) => Math.min(255, Math.round(c + (255 - c) * 0.3))
  const fg = `#${[mix(r), mix(g), mix(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`
  return {
    bar: hex,
    fg,
    bg: `rgba(${r}, ${g}, ${b}, 0.14)`,
  }
}

export function bindSettingsEvents() {
  // FAB: 서브메뉴 열림/닫힘 토글 (모달이 열려 있으면 모달 닫기 = 취소와 동일)
  const settingsFab = document.getElementById('btn-open-settings')
  if (settingsFab) {
    on(settingsFab, 'click', (e) => {
      // 전역 click 핸들러(바깥 클릭 닫기)가 토글 직후 다시 닫지 않도록 전파 차단
      e.stopPropagation()
      if (state.showSettings) {
        closeSettings()
        return
      }
      state.showSettingsMenu = !state.showSettingsMenu
      render({ sections: ['settings-fab'] })
    })
  }

  // 서브메뉴: 설정 모달 열기 버튼들
  document.querySelectorAll('[data-settings-open]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      openSettingsModal(btn.dataset.settingsOpen)
    })
  })

  // 서브메뉴: 위젯 다운로드 링크 — 새 탭으로 열리므로 메뉴만 닫는다
  const widgetLink = document.getElementById('settings-widget-download')
  if (widgetLink) {
    on(widgetLink, 'click', () => {
      state.showSettingsMenu = false
      render({ sections: ['settings-fab'] })
    })
  }

  // 취소
  const settingsCancel = document.getElementById('settings-cancel')
  if (settingsCancel) on(settingsCancel, 'click', closeSettings)

  // 재설정 — 현재 열린 모달의 항목만 draft에 되돌린다 (저장을 눌러야 실제 적용)
  const settingsReset = document.getElementById('settings-reset')
  if (settingsReset) {
    on(settingsReset, 'click', () => {
      if (state.showSettings === 'holidays') {
        state.holidaysDraft = holidayMapToList(getBaseHolidays())
        render({ sections: ['modals'] })
        showToast('기본 공휴일 목록으로 되돌렸습니다. 저장을 누르면 적용됩니다.', 'ℹ')
        return
      }
      if (!state.settingsDraft) return
      if (state.showSettings === 'issues') {
        state.settingsDraft.statusOrder = [...DEFAULT_STATUS_ORDER]
        state.settingsDraft.projectOrder = [...DEFAULT_PROJECT_ORDER]
        state.settingsDraft.projectColors = JSON.parse(JSON.stringify(DEFAULT_PROJECT_COLORS))
        applyPreferences(state.settingsDraft) // 색상 미리보기 반영
      } else {
        state.settingsDraft.summaryWeekStart = DEFAULT_SUMMARY_WEEK_START
        state.settingsDraft.lunchStart = LUNCH_START
        state.settingsDraft.lunchEnd = LUNCH_END
      }
      render({ sections: ['modals'] })
      showToast('기본값으로 되돌렸습니다. 저장을 누르면 적용됩니다.', 'ℹ')
    })
  }

  // 저장
  const settingsSave = document.getElementById('settings-save')
  if (settingsSave) {
    on(settingsSave, 'click', () => {
      if (state.showSettings === 'holidays') {
        if (!state.holidaysDraft) return
        saveHolidaysFromList(state.holidaysDraft)
        state.showSettings = null
        state.holidaysDraft = null
        render()
        showToast('공휴일 설정을 저장했습니다.', '✓')
        return
      }
      if (!state.settingsDraft) return
      savePreferences(state.settingsDraft)
      applyPreferences(state.settingsDraft)
      state.showSettings = null
      state.settingsDraft = null
      render()
      showToast('설정을 저장했습니다.', '✓')
    })
  }

  // ===== 공휴일 모달 =====
  // 이름 인라인 수정 (재렌더하지 않음 — 입력 포커스 유지)
  document.querySelectorAll('[data-holiday-idx]').forEach(input => {
    on(input, 'change', () => {
      const idx = parseInt(input.dataset.holidayIdx, 10)
      if (state.holidaysDraft?.[idx]) state.holidaysDraft[idx].name = input.value.trim()
    })
  })

  // 항목 삭제
  document.querySelectorAll('[data-holiday-remove]').forEach(btn => {
    on(btn, 'click', () => {
      const idx = parseInt(btn.dataset.holidayRemove, 10)
      if (!state.holidaysDraft?.[idx]) return
      state.holidaysDraft.splice(idx, 1)
      render({ sections: ['modals'] })
    })
  })

  // 항목 추가
  const holidayAddBtn = document.getElementById('holiday-add-btn')
  if (holidayAddBtn) {
    const addHoliday = () => {
      if (!state.holidaysDraft) return
      const date = document.getElementById('holiday-add-date')?.value
      const name = document.getElementById('holiday-add-name')?.value.trim()
      if (!date) { showToast('추가할 날짜를 선택하세요.', '!'); return }
      if (!name) { showToast('공휴일 이름을 입력하세요.', '!'); return }
      if (state.holidaysDraft.some(h => h.date === date)) {
        showToast('이미 등록된 날짜입니다. 목록에서 이름을 수정하세요.', '!')
        return
      }
      state.holidaysDraft.push({ date, name })
      state.holidaysDraft.sort((a, b) => a.date.localeCompare(b.date))
      render({ sections: ['modals'] })
    }
    on(holidayAddBtn, 'click', addHoliday)
    const holidayAddName = document.getElementById('holiday-add-name')
    if (holidayAddName) {
      on(holidayAddName, 'keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addHoliday() }
      })
    }
  }

  // 주 시작 요일 세그먼트 버튼
  document.querySelectorAll('[data-week-start]').forEach(btn => {
    on(btn, 'click', () => {
      if (!state.settingsDraft) return
      state.settingsDraft.summaryWeekStart = btn.dataset.weekStart
      render({ sections: ['modals'] })
    })
  })

  // 기본 점심시간 입력 (분 단위로 draft에 저장). 무효 입력은 무시해 기존 값 유지.
  // (재렌더하지 않음 — input이 자체 값을 들고 있어 포커스/커서를 깨지 않기 위함)
  document.querySelectorAll('.settings-lunch-start, .settings-lunch-end').forEach(input => {
    on(input, 'change', () => {
      if (!state.settingsDraft) return
      const startMin = parseHHMM(document.querySelector('.settings-lunch-start')?.value)
      const endMin = parseHHMM(document.querySelector('.settings-lunch-end')?.value)
      if (startMin != null) state.settingsDraft.lunchStart = startMin
      if (endMin != null) state.settingsDraft.lunchEnd = endMin
    })
  })

  // 프로젝트 색상 변경 (input type=color의 change 이벤트)
  document.querySelectorAll('[data-project-color]').forEach(input => {
    on(input, 'change', (e) => {
      const projectKey = input.dataset.projectColor
      const hex = e.target.value
      const colors = deriveProjectColors(hex)
      state.settingsDraft.projectColors[projectKey] = colors
      // 즉시 미리보기 CSS 변수 업데이트 (저장 전에도 시각 확인 가능)
      applyPreferences(state.settingsDraft)
      render({ sections: ['modals'] })
    })
  })

  // 드래그 앤 드롭 순서 변경 (포인터 기반, 밀림 애니메이션)
  document.querySelectorAll('.settings-drag-handle').forEach(handle => {
    on(handle, 'mousedown', (e) => {
      e.preventDefault()
      const item = handle.closest('.settings-order-item')
      if (!item) return
      const list = item.closest('.settings-order-list')
      const items = [...list.querySelectorAll('.settings-order-item')]
      const kind = item.dataset.kind
      const fromIdx = parseInt(item.dataset.idx, 10)
      const rects = items.map(el => el.getBoundingClientRect())
      const listGap = 4 // settings-order-list gap
      const stepH = rects[0].height + listGap

      // 고스트(드래그 중 커서 따라다니는 복제 요소)
      const ghost = item.cloneNode(true)
      ghost.className = 'settings-order-item drag-ghost'
      ghost.style.cssText = `position:fixed;left:${rects[fromIdx].left}px;top:${rects[fromIdx].top}px;width:${rects[fromIdx].width}px;z-index:999;pointer-events:none;`
      document.body.appendChild(ghost)

      item.classList.add('drag-placeholder')
      const startY = e.clientY
      const ghostStartTop = rects[fromIdx].top
      let currentIdx = fromIdx

      function onMove(ev) {
        const dy = ev.clientY - startY
        ghost.style.top = (ghostStartTop + dy) + 'px'

        // 고스트 중심 Y로 삽입 위치 계산
        const midY = ghostStartTop + dy + rects[fromIdx].height / 2
        let newIdx = 0
        for (let i = 0; i < rects.length; i++) {
          if (midY > rects[i].top + rects[i].height / 2) newIdx = i
        }
        newIdx = Math.max(0, Math.min(newIdx, items.length - 1))

        if (newIdx !== currentIdx) {
          currentIdx = newIdx
          items.forEach((el, i) => {
            if (i === fromIdx) return
            if (fromIdx < currentIdx) {
              el.style.transform = (i > fromIdx && i <= currentIdx) ? `translateY(-${stepH}px)` : ''
            } else {
              el.style.transform = (i >= currentIdx && i < fromIdx) ? `translateY(${stepH}px)` : ''
            }
          })
        }
      }

      function onUp() {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        ghost.remove()
        item.classList.remove('drag-placeholder')
        items.forEach(el => { el.style.transform = '' })

        if (currentIdx !== fromIdx) {
          const arr = kind === 'status'
            ? state.settingsDraft.statusOrder
            : state.settingsDraft.projectOrder
          const [moved] = arr.splice(fromIdx, 1)
          arr.splice(currentIdx, 0, moved)
        }
        render({ sections: ['modals'] })
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })
  })
}
