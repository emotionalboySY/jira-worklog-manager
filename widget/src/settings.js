// 위젯 설정 창(별도 window). 트레이 메뉴 '설정' 또는 위젯 헤더의 톱니 버튼으로 열린다.
//
// 값의 소유·저장 위치
// - 투명도/기본 점심시간/자동 실행: 이 창에서 변경하고 settings.json(또는 레지스트리)에 저장.
//   투명도는 본체 CSS 변수라 변경 즉시 'widget-opacity' 이벤트로 본체에 반영한다.
// - 클릭 통과: 상태는 Rust가 소유(트레이 메뉴에서도 토글되므로). 여기선 invoke로 토글하고
//   'click-through-changed' 이벤트로 체크 상태를 맞춘다. 영속 저장은 본체(main.js)가 담당.
import { getCurrentWindow } from '@tauri-apps/api/window'
import { emit, listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { load } from '@tauri-apps/plugin-store'
import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from '@tauri-apps/plugin-autostart'
import { fmtHHMM, parseHHMM } from './shared.js'
import { DEFAULT_LUNCH } from '../../lib/worklogLogic.js'
import { runUpdateCheck } from './update.js'

const win = getCurrentWindow()

let _settings = null
async function settingsStore() {
  if (!_settings) _settings = await load('settings.json', { autoSave: true })
  return _settings
}

document.getElementById('settings-app').innerHTML = `
  <div class="dlg set-dlg">
    <div class="set-section">표시</div>
    <div class="set-item">
      <span class="set-name">투명도</span>
      <span class="set-ctrl">
        <input type="range" id="op-range" min="0.3" max="1" step="0.01" value="0.96">
        <span class="set-val" id="op-val">96%</span>
      </span>
    </div>
    <label class="set-item set-check">
      <input type="checkbox" id="click-through-chk">
      <span class="set-name">클릭 통과</span>
    </label>
    <div class="set-desc">위젯이 마우스 입력을 무시해 아래에 있는 창이 클릭을 받습니다. 켜면 위젯 자체를 클릭할 수 없으니 해제는 이 창 또는 트레이 아이콘 우클릭 → <b>클릭 통과</b>에서 하세요.</div>

    <div class="set-section">동작</div>
    <label class="set-item set-check">
      <input type="checkbox" id="autostart-chk">
      <span class="set-name">Windows 시작 시 자동 실행</span>
    </label>
    <div class="set-item">
      <span class="set-name">기본 점심시간</span>
      <span class="set-ctrl">
        <input type="time" id="lunch-start" class="set-time">
        <span class="set-tilde">~</span>
        <input type="time" id="lunch-end" class="set-time">
      </span>
    </div>

    <div class="set-section">업데이트</div>
    <div class="set-item">
      <span class="set-name">현재 버전</span>
      <span class="set-val" id="app-ver">…</span>
    </div>
    <button class="set-update-btn" id="btn-check-update">업데이트 확인</button>

    <div class="dlg-actions set-actions"><button id="btn-close">닫기</button></div>
  </div>`

const $ = (id) => document.getElementById(id)

// ===== 투명도 — 변경 즉시 본체에 반영, 손을 뗄 때 저장 =====
const opRange = $('op-range')
const opVal = $('op-val')
function showOpacity(v) {
  opRange.value = String(v)
  opVal.textContent = `${Math.round(v * 100)}%`
}
opRange.addEventListener('input', () => {
  const v = parseFloat(opRange.value)
  opVal.textContent = `${Math.round(v * 100)}%`
  emit('widget-opacity', v).catch(console.error)
})
opRange.addEventListener('change', async () => {
  try {
    const s = await settingsStore()
    await s.set('opacity', parseFloat(opRange.value))
    await s.save()
  } catch (e) { console.error('투명도 저장 실패:', e) }
})

// ===== 클릭 통과 — 상태는 Rust 소유, 트레이 메뉴 토글도 이벤트로 따라온다 =====
const ctChk = $('click-through-chk')
ctChk.addEventListener('change', async () => {
  const want = ctChk.checked
  try { await invoke('set_click_through', { enabled: want }) }
  catch (e) { console.error('클릭 통과 적용 실패:', e); ctChk.checked = !want }
})
listen('click-through-changed', ({ payload }) => { ctChk.checked = !!payload })

// ===== 시작 시 자동 실행 =====
const asChk = $('autostart-chk')
asChk.addEventListener('change', async () => {
  const want = asChk.checked
  try { want ? await enableAutostart() : await disableAutostart() }
  catch (e) { console.error('자동 실행 설정 실패:', e); asChk.checked = !want }   // 실패 시 되돌림
})

// ===== 기본 점심시간(종료 다이얼로그의 기본값) =====
const lsEl = $('lunch-start')
const leEl = $('lunch-end')
const onLunchChange = async () => {
  const s = parseHHMM(lsEl.value)
  const e = parseHHMM(leEl.value)
  if (s == null || e == null) return
  try {
    const st = await settingsStore()
    await st.set('lunchStart', s)
    await st.set('lunchEnd', e)
    await st.save()
  } catch (err) { console.error('점심시간 저장 실패:', err) }
}
lsEl.addEventListener('change', onLunchChange)
leEl.addEventListener('change', onLunchChange)

// ===== 업데이트 / 닫기 =====
const upBtn = $('btn-check-update')
upBtn.addEventListener('click', () => runUpdateCheck(upBtn))
$('btn-close').addEventListener('click', () => win.close().catch(console.error))
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') win.close().catch(console.error)
})

// ===== 현재 값 로드 =====
async function loadCurrent() {
  try {
    const s = await settingsStore()
    const v = await s.get('opacity')
    showOpacity(typeof v === 'number' ? v : 0.96)
    const ls = await s.get('lunchStart')
    const le = await s.get('lunchEnd')
    const lunch = (typeof ls === 'number' && typeof le === 'number') ? { start: ls, end: le } : { ...DEFAULT_LUNCH }
    lsEl.value = fmtHHMM(lunch.start)
    leEl.value = fmtHHMM(lunch.end)
  } catch (e) { console.error('설정 로드 실패:', e) }

  isAutostartEnabled().then(on => { asChk.checked = on }).catch(e => console.error(e))
  invoke('get_click_through').then(on => { ctChk.checked = !!on }).catch(e => console.error(e))
  getVersion().then(v => { $('app-ver').textContent = `v${v}` }).catch(() => { $('app-ver').textContent = '-' })
}
loadCurrent()
