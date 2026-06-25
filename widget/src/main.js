// Jira 업무 기록 위젯 — 엔트리.
// 로그인(데스크톱 OAuth) → 오늘 합계 + 진행 중 세션 표시(경과시계 1초 틱) → 폴링 동기 + 중단/재개.
// 새 일감 시작/전환은 웹앱에서, 종료(코멘트 입력)는 다음 단계에서 추가.
import { getCurrentWindow } from '@tauri-apps/api/window'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { CONFIG } from './config.js'
import { isLoggedIn, login } from './auth.js'
import { getSessions, postSessionAction, getLatestWorklogEnd } from './api.js'
import { escapeHtml, fmtHHMM, parseHHMM, NO_ISSUE_KEY } from './shared.js'
import { DEFAULT_LUNCH } from '../../lib/worklogLogic.js'
import { load } from '@tauri-apps/plugin-store'
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from '@tauri-apps/plugin-autostart'
import { check as checkUpdate } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

const appWindow = getCurrentWindow()
let alwaysOnTop = true
let opacity = 0.96   // 위젯 불투명도(styles.css --widget-opacity 기본값과 일치)

const state = {
  phase: 'loading',     // 'loading' | 'login' | 'ready' | 'error'
  error: null,
  sessions: [],
  rev: 0,
  busy: false,          // 컨트롤 동작 중
  notice: null,         // 일시 안내 메시지
}

let pollTimer = null
let tickTimer = null

// ===== 시간 헬퍼 (백엔드가 권위, 여기선 표시용 계산만) =====
function elapsedMs(session, nowMs) {
  let total = 0
  for (const seg of session.segments || []) {
    const end = seg.end ? Date.parse(seg.end) : nowMs
    total += end - Date.parse(seg.start)
  }
  return Math.max(0, total)
}
function fmtClock(ms) {
  const s = Math.floor(ms / 1000)
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}
// 시각(ms 또는 ISO) → "HH:MM"
function fmtTime(t) {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function activeSession() {
  return state.sessions.find(s => s.status === 'active') || null
}
function pausedSessions() {
  return state.sessions.filter(s => s.status === 'paused')
}

// 헤더 버튼 flat 아이콘(line, currentColor 단색)
const ICONS = {
  gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="16" x2="12" y2="22"/><path d="M5 16h14l-1.6-3.2a2 2 0 0 1-.2-.9V5a1 1 0 0 0-1-1H8.8a1 1 0 0 0-1 1v6.9a2 2 0 0 1-.2.9z"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
}

// ===== 렌더 =====
function render() {
  const app = document.getElementById('app')
  app.innerHTML = `
    <div class="widget">
      <div class="widget-header" data-tauri-drag-region>
        <span class="widget-title" data-tauri-drag-region>Jira 업무 기록</span>
        <div class="widget-win-buttons">
          <button class="win-btn" id="btn-open-web" title="웹에서 열기 (Chrome)">${ICONS.globe}</button>
          <button class="win-btn" id="btn-settings" title="설정">${ICONS.gear}</button>
          <button class="win-btn ${alwaysOnTop ? 'active' : ''}" id="btn-pin" title="항상 위 고정">${ICONS.pin}</button>
          <button class="win-btn" id="btn-hide" title="숨기기">▁</button>
          <button class="win-btn" id="btn-close" title="닫기">✕</button>
        </div>
      </div>
      <div class="widget-body">${renderBody()}</div>
    </div>
  `
  bindCommon()
  bindBody()
  startTick()
}

function renderBody() {
  if (state.phase === 'loading') return `<div class="placeholder">불러오는 중…</div>`
  if (state.phase === 'login') {
    return `
      <div class="login-box">
        <div class="login-msg">Jira에 로그인하세요</div>
        <button class="btn-primary" id="btn-login">로그인</button>
      </div>`
  }
  if (state.phase === 'error') {
    return `
      <div class="login-box">
        <div class="err">${escapeHtml(state.error)}</div>
        <button class="btn-sm" id="btn-retry">다시 시도</button>
      </div>`
  }
  // ready
  const act = activeSession()
  const paused = pausedSessions()

  let sessionHtml
  if (act) {
    const isNoIssue = act.issueKey === NO_ISSUE_KEY
    const startMs = Date.parse(act.segments[0].start)
    sessionHtml = `
      <div class="session active">
        <div class="session-issue">
          <span class="dot live"></span>
          <span class="issue-key">${isNoIssue ? '(일감 미지정)' : escapeHtml(act.issueKey)}</span>
          <span class="issue-summary">${escapeHtml(act.summary)}</span>
        </div>
        <div class="session-row">
          <div class="time-col">
            <span class="start-time">시작 ${fmtTime(startMs)}</span>
            <span class="clock" id="clock" data-key="${escapeHtml(act.issueKey)}">${fmtClock(elapsedMs(act, Date.now()))}</span>
          </div>
          <div class="ctrls">
            <button class="btn-sm" data-act="pause" data-key="${escapeHtml(act.issueKey)}" ${state.busy ? 'disabled' : ''}>중단</button>
            <button class="btn-sm btn-finish" data-act="finish" data-key="${escapeHtml(act.issueKey)}" ${state.busy ? 'disabled' : ''}>종료</button>
          </div>
        </div>
        <div class="session-actions"><button class="btn-link" data-act="swap" data-key="${escapeHtml(act.issueKey)}" ${state.busy ? 'disabled' : ''}>${isNoIssue ? '일감 지정' : '일감 교체'}</button><button class="btn-link" data-act="adjustStart" data-key="${escapeHtml(act.issueKey)}" ${state.busy ? 'disabled' : ''}>직전 종료 시간으로</button></div>
      </div>`
  } else if (paused.length) {
    const p = paused[0]
    const isNoIssue = p.issueKey === NO_ISSUE_KEY
    const startMs = Date.parse(p.segments[0].start)
    sessionHtml = `
      <div class="session paused">
        <div class="session-issue">
          <span class="dot"></span>
          <span class="issue-key">${isNoIssue ? '(일감 미지정)' : escapeHtml(p.issueKey)}</span>
          <span class="issue-summary">${escapeHtml(p.summary)}</span>
        </div>
        <div class="session-row">
          <div class="time-col">
            <span class="start-time">시작 ${fmtTime(startMs)}</span>
            <span class="clock paused-clock">${fmtClock(elapsedMs(p, Date.now()))} · 중단됨</span>
          </div>
          <div class="ctrls">
            <button class="btn-sm" data-act="resume" data-key="${escapeHtml(p.issueKey)}" ${state.busy ? 'disabled' : ''}>재개</button>
            <button class="btn-sm btn-finish" data-act="finish" data-key="${escapeHtml(p.issueKey)}" ${state.busy ? 'disabled' : ''}>종료</button>
          </div>
        </div>
        <div class="session-actions"><button class="btn-link" data-act="swap" data-key="${escapeHtml(p.issueKey)}" ${state.busy ? 'disabled' : ''}>${isNoIssue ? '일감 지정' : '일감 교체'}</button><button class="btn-link" data-act="adjustStart" data-key="${escapeHtml(p.issueKey)}" ${state.busy ? 'disabled' : ''}>직전 종료 시간으로</button></div>
      </div>`
  } else {
    sessionHtml = `<div class="placeholder">진행 중인 작업이 없습니다.<br/><span class="dim">웹앱에서 작업을 시작하세요.</span></div>`
  }

  return `
    ${sessionHtml}
    ${state.notice ? `<div class="notice">${escapeHtml(state.notice)}</div>` : ''}
  `
}

// ===== 이벤트 =====
function bindCommon() {
  document.getElementById('btn-open-web')?.addEventListener('click', async () => {
    try { await invoke('open_in_chrome', { url: CONFIG.apiBase }) }
    catch (e) { console.error('웹 열기 실패:', e); showNotice('Chrome으로 열지 못했습니다.') }
  })
  document.getElementById('btn-settings')?.addEventListener('click', toggleSettingsPanel)
  document.getElementById('btn-pin')?.addEventListener('click', async () => {
    alwaysOnTop = !alwaysOnTop
    try { await appWindow.setAlwaysOnTop(alwaysOnTop) } catch (e) { console.error(e) }
    render()
  })
  document.getElementById('btn-hide')?.addEventListener('click', () => appWindow.hide().catch(console.error))
  document.getElementById('btn-close')?.addEventListener('click', () => appWindow.close().catch(console.error))
}

// ===== 투명도(--widget-opacity) — 슬라이더로 조절, settings.json에 영속 =====
let _settings = null
async function settingsStore() {
  if (!_settings) _settings = await load('settings.json', { autoSave: true })
  return _settings
}
function applyOpacity(v) {
  document.documentElement.style.setProperty('--widget-opacity', String(v))
}
async function loadOpacity() {
  try {
    const v = await (await settingsStore()).get('opacity')
    if (typeof v === 'number') { opacity = v; applyOpacity(v) }
  } catch (e) { console.error(e) }
}
async function saveOpacity(v) {
  try { const s = await settingsStore(); await s.set('opacity', v); await s.save() } catch (e) { console.error(e) }
}

// ===== 기본 점심시간(settings.json) — 종료 다이얼로그가 같은 파일에서 읽어 기본값으로 사용 =====
async function loadLunchSetting() {
  try {
    const s = await settingsStore()
    const ls = await s.get('lunchStart')
    const le = await s.get('lunchEnd')
    if (typeof ls === 'number' && typeof le === 'number') return { start: ls, end: le }
  } catch (e) { console.error(e) }
  return { ...DEFAULT_LUNCH }
}
async function saveLunchSetting(start, end) {
  try { const s = await settingsStore(); await s.set('lunchStart', start); await s.set('lunchEnd', end); await s.save() }
  catch (e) { console.error(e) }
}

// 설정 패널(투명도 + 자동시작)은 render() 밖의 독립 DOM — 폴링 재렌더가 드래그를 끊지 않도록 한다.
let settingsPanel = null
function toggleSettingsPanel() {
  if (settingsPanel) { settingsPanel.remove(); settingsPanel = null; return }
  const panel = document.createElement('div')
  panel.className = 'settings-panel'
  panel.innerHTML = `
    <div class="set-row">
      <span class="set-label">투명도</span>
      <input type="range" id="op-range" min="0.3" max="1" step="0.01" value="${opacity}">
    </div>
    <label class="set-row set-toggle">
      <input type="checkbox" id="autostart-chk">
      <span class="set-label">시작 시 자동 실행</span>
    </label>
    <div class="set-row set-lunch">
      <span class="set-label">기본 점심시간</span>
      <input type="time" id="lunch-start-set" class="set-time">
      <span class="set-tilde">~</span>
      <input type="time" id="lunch-end-set" class="set-time">
    </div>
    <div class="set-row set-update">
      <button class="set-update-btn" id="btn-check-update">업데이트 확인</button>
    </div>`
  document.body.appendChild(panel)
  // 투명도 슬라이더
  const range = panel.querySelector('#op-range')
  range.addEventListener('input', () => { opacity = parseFloat(range.value); applyOpacity(opacity) })
  range.addEventListener('change', () => saveOpacity(opacity))
  // 자동시작 토글 — 현재 등록 상태 조회 후 반영, 변경 시 enable/disable
  const chk = panel.querySelector('#autostart-chk')
  isAutostartEnabled().then(on => { chk.checked = on }).catch(e => console.error(e))
  chk.addEventListener('change', async () => {
    const want = chk.checked
    try { want ? await enableAutostart() : await disableAutostart() }
    catch (e) { console.error(e); chk.checked = !want }   // 실패 시 체크 상태 되돌림
  })
  // 기본 점심시간 — 저장값 복원 후, 변경 시 settings.json에 저장(종료 다이얼로그 기본값)
  const lsEl = panel.querySelector('#lunch-start-set')
  const leEl = panel.querySelector('#lunch-end-set')
  loadLunchSetting().then(l => { lsEl.value = fmtHHMM(l.start); leEl.value = fmtHHMM(l.end) }).catch(e => console.error(e))
  const onLunchChange = () => {
    const s = parseHHMM(lsEl.value)
    const e = parseHHMM(leEl.value)
    if (s != null && e != null) saveLunchSetting(s, e)
  }
  lsEl.addEventListener('change', onLunchChange)
  leEl.addEventListener('change', onLunchChange)
  // 업데이트 확인
  const upBtn = panel.querySelector('#btn-check-update')
  upBtn.addEventListener('click', () => checkForUpdate(upBtn))
  settingsPanel = panel
}

// ===== 자동 업데이트 =====
async function checkForUpdate(btn) {
  btn.disabled = true
  btn.classList.remove('is-latest', 'is-error')
  btn.textContent = '업데이트 확인 중…'
  try {
    const update = await checkUpdate()
    if (update) {
      // 업데이트 있음 → 버튼 원복 후 설치 모달
      btn.textContent = '업데이트 확인'
      btn.disabled = false
      showUpdateModal(update)
    } else {
      // 최신 → 초록 버튼 + 메시지, 3초 후 원래대로 fade 회귀
      btn.textContent = '최신 버전입니다!'
      btn.classList.add('is-latest')
      setTimeout(() => {
        btn.classList.remove('is-latest')
        btn.textContent = '업데이트 확인'
        btn.disabled = false
      }, 3000)
    }
  } catch (e) {
    console.error('업데이트 확인 실패:', e)
    btn.textContent = '확인 실패'
    btn.classList.add('is-error')
    setTimeout(() => {
      btn.classList.remove('is-error')
      btn.textContent = '업데이트 확인'
      btn.disabled = false
    }, 3000)
  }
}

// 시작 시 1회 자동 업데이트 확인 — 있으면 설치 모달, 없거나 실패면 조용히 무시(버튼 UI 없음).
let autoUpdateChecked = false
async function autoCheckUpdateOnce() {
  if (autoUpdateChecked) return   // boot 재호출(재시도 등)에도 1회만
  autoUpdateChecked = true
  try {
    const update = await checkUpdate()
    if (update) showUpdateModal(update)
  } catch (e) {
    console.error('시작 시 자동 업데이트 확인 실패:', e)
  }
}

// 업데이트 설치 확인 모달(위젯 본체 위 오버레이)
function showUpdateModal(update) {
  if (settingsPanel) { settingsPanel.remove(); settingsPanel = null }
  const overlay = document.createElement('div')
  overlay.className = 'update-overlay'
  overlay.innerHTML = `
    <div class="update-modal">
      <div class="update-title">업데이트가 있습니다</div>
      <div class="update-ver">v${escapeHtml(update.version)}${update.currentVersion ? ` <span class="dim">(현재 v${escapeHtml(update.currentVersion)})</span>` : ''}</div>
      <div class="update-progress dim" id="update-progress"></div>
      <div class="update-actions">
        <button class="btn-sm" id="update-later">나중에</button>
        <button class="btn-sm btn-primary" id="update-now">설치</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  overlay.querySelector('#update-later').onclick = () => overlay.remove()
  overlay.querySelector('#update-now').onclick = async () => {
    const now = overlay.querySelector('#update-now')
    const later = overlay.querySelector('#update-later')
    const prog = overlay.querySelector('#update-progress')
    now.disabled = true; later.disabled = true; now.textContent = '설치 중…'
    try {
      let downloaded = 0, total = 0
      await update.downloadAndInstall((e) => {
        if (e.event === 'Started') { total = (e.data && e.data.contentLength) || 0; prog.textContent = '다운로드 중…' }
        else if (e.event === 'Progress') { downloaded += (e.data && e.data.chunkLength) || 0; prog.textContent = total ? `다운로드 ${Math.round(downloaded / total * 100)}%` : '다운로드 중…' }
        else if (e.event === 'Finished') { prog.textContent = '설치 후 재시작합니다…' }
      })
      await relaunch()
    } catch (err) {
      console.error('업데이트 설치 실패:', err)
      prog.textContent = '설치 실패'
      now.disabled = false; later.disabled = false; now.textContent = '설치'
    }
  }
}

function bindBody() {
  document.getElementById('btn-login')?.addEventListener('click', doLogin)
  document.getElementById('btn-retry')?.addEventListener('click', boot)
  document.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', () => doAction(btn.dataset.act, btn.dataset.key))
  })
}

async function doLogin() {
  state.phase = 'loading'; render()
  try {
    await login()
    await loadAll()
    startPolling()
  } catch (e) {
    state.phase = 'error'; state.error = e.message || '로그인 실패'; render()
  }
}

async function doAction(action, key) {
  if (state.busy) return
  if (action === 'finish') {
    if (key === NO_ISSUE_KEY) { showNotice('일감 미지정 세션은 웹앱에서 종료해주세요.'); return }
    openFinishDialog(key)
    return
  }
  if (action === 'adjustStart') { handleAdjustStart(key); return }
  if (action === 'swap') {
    openSwapDialog(key)   // 미지정 세션이면 swap.html이 '일감 지정' 모드로 동작
    return
  }
  state.busy = true; render()
  try {
    const { status, data } = await postSessionAction(action, { issueKey: key, nowMs: Date.now() })
    // 4xx 검증 실패/409 충돌 응답에도 서버가 최신 sessions/rev를 실어 보내므로 보정에 활용
    if (data && Array.isArray(data.sessions) && typeof data.rev === 'number' && data.rev >= state.rev) {
      state.sessions = data.sessions
      state.rev = data.rev
    }
    if (status !== 200) {
      showNotice((data && data.error) || `동작이 적용되지 않았습니다 (${status})`)
    }
  } catch (e) {
    // 네트워크 단절 등 — 무성 유실 대신 사용자에게 알림 (변이는 적용되지 않음)
    console.error('동작 실패:', e)
    showNotice('동기화 실패 — 네트워크 확인 후 다시 시도해주세요.')
  } finally {
    state.busy = false
    render()
  }
}

// '직전 종료 시간으로' — 그 날 마지막 worklog 종료 시각으로 세션 시작 시각을 조정
async function handleAdjustStart(key) {
  if (state.busy) return
  const s = state.sessions.find(x => x.issueKey === key)
  if (!s || !s.segments.length) return
  state.busy = true; render()
  let msg = ''
  try {
    const startDate = new Date(s.segments[0].start)
    const latestEnd = await getLatestWorklogEnd(startDate)
    if (!latestEnd) msg = '해당 날짜에 기록된 작업 로그가 없습니다.'
    else if (latestEnd.getTime() >= startDate.getTime()) msg = '직전 종료 시간이 현재 시작보다 늦어 조정할 수 없습니다.'
    else {
      const { status, data } = await postSessionAction('adjustStart', { issueKey: key, newStartMs: latestEnd.getTime() })
      if (data && Array.isArray(data.sessions) && typeof data.rev === 'number' && data.rev >= state.rev) {
        state.sessions = data.sessions
        state.rev = data.rev
      }
      // 409(동시 수정 충돌)·400은 적용 실패 — 성공 메시지를 띄우지 않는다
      msg = status === 200
        ? `시작 시간을 ${fmtTime(latestEnd)}(으)로 조정했습니다.`
        : ((data && data.error) || '조정이 적용되지 않았습니다. 다시 시도해주세요.')
    }
  } catch (e) {
    console.error('직전 종료 시간 조정 실패:', e)
    msg = '조정에 실패했습니다.'
  } finally {
    state.busy = false
    render()
  }
  if (msg) showNotice(msg)
}

// 다이얼로그 창 열기 공통: 같은 key로 이미 떠 있으면 포커스만, 다른 key면 닫고 새로 연다.
// (기존: key 비교 없이 포커스만 해서 다른 일감에 대한 요청이 무시됐음)
const _dialogKeys = {}   // label → 마지막으로 연 key
async function openDialogWindow(label, key, options) {
  try {
    const existing = await WebviewWindow.getByLabel(label)
    if (existing) {
      if (_dialogKeys[label] === key) { await existing.setFocus(); return }
      // 다른 일감 대상 — 기존 창을 닫고 destroy 완료를 기다린 뒤 재생성 (label 충돌 방지)
      const destroyed = new Promise(resolve => {
        existing.once('tauri://destroyed', resolve)
        setTimeout(resolve, 500)   // destroy 이벤트 유실 대비 안전장치
      })
      await existing.close()
      await destroyed
    }
  } catch {}
  _dialogKeys[label] = key
  const w = new WebviewWindow(label, options)
  w.once('tauri://error', (e) => console.error(`${label} 창 생성 오류:`, e))
}

// 종료 다이얼로그(별도 작은 창) 열기.
function openFinishDialog(key) {
  return openDialogWindow('finish', key, {
    url: `finish.html?key=${encodeURIComponent(key)}`,
    title: '작업 종료',
    width: 400,
    height: 430,
    minWidth: 360,
    minHeight: 320,
    resizable: true,
    center: true,
    alwaysOnTop: true,
    decorations: true,
    skipTaskbar: true,
  })
}

// 일감 교체 다이얼로그(별도 작은 창) 열기.
function openSwapDialog(key) {
  return openDialogWindow('swap', key, {
    url: `swap.html?key=${encodeURIComponent(key)}`,
    title: key === NO_ISSUE_KEY ? '일감 지정' : '일감 교체',
    width: 440,
    height: 480,
    minWidth: 380,
    minHeight: 360,
    resizable: true,
    center: true,
    alwaysOnTop: true,
    decorations: true,
    skipTaskbar: true,
  })
}

let noticeTimer = null
function showNotice(msg) {
  state.notice = msg
  render()
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { state.notice = null; render() }, 3500)
}

// ===== 데이터 로드 / 폴링 / 틱 =====
async function loadAll() {
  const data = await getSessions()
  state.sessions = data.sessions || []
  state.rev = data.rev || 0
  state.phase = 'ready'
  state.error = null
  render()
}

function pollDelay() {
  return activeSession() ? 3000 : 10000
}
let pollFailures = 0
function startPolling() {
  stopPolling()
  pollFailures = 0
  const tick = async () => {
    try {
      const data = await getSessions()
      pollFailures = 0
      if ((data.rev || 0) >= state.rev) {
        const changed = JSON.stringify(state.sessions) !== JSON.stringify(data.sessions)
        state.sessions = data.sessions || []
        state.rev = data.rev || 0
        if (changed) render()
      }
    } catch (e) {
      if (e.code === 'unauthorized' || e.code === 'not-authed') { handleLogout(); return }
      pollFailures++
    }
    // 연속 실패 시 지수 백오프(최대 30초) — 네트워크 단절 중 무의미한 재시도 폭주 방지
    const delay = pollFailures > 0
      ? Math.min(30000, pollDelay() * Math.pow(2, pollFailures))
      : pollDelay()
    pollTimer = setTimeout(tick, delay)
  }
  pollTimer = setTimeout(tick, pollDelay())
}
function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
}

// 활성 세션의 경과시계만 1초마다 갱신(네트워크 없음)
function startTick() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
  const clockEl = document.getElementById('clock')
  if (!clockEl) return
  const key = clockEl.dataset.key
  tickTimer = setInterval(() => {
    const s = state.sessions.find(x => x.issueKey === key && x.status === 'active')
    if (!s || !clockEl.isConnected) { clearInterval(tickTimer); tickTimer = null; return }
    clockEl.textContent = fmtClock(elapsedMs(s, Date.now()))
  }, 1000)
}

function handleLogout() {
  stopPolling()
  state.phase = 'login'
  state.sessions = []
  state.rev = 0
  render()
}

// ===== 부트 =====
async function boot() {
  state.phase = 'loading'; render()
  loadOpacity()   // 저장된 투명도 복원(비동기, 적용은 준비되는 대로)
  try {
    if (await isLoggedIn()) {
      await loadAll()
      startPolling()
    } else {
      state.phase = 'login'; render()
    }
  } catch (e) {
    // 토큰은 있는데 호출 실패 → 에러 표시(재시도/로그아웃 가능하도록)
    state.phase = 'error'; state.error = e.message || '불러오기 실패'; render()
  }
}

// 종료 다이얼로그가 세션을 제거하면 본체를 즉시 갱신
listen('sessions-changed', () => { loadAll().catch(() => {}) })

// 마그넷 스냅 + 비율 고정 리사이즈는 Rust(Windows 창 메시지 후킹)에서 실시간 처리

// 부트 후 시작 시 1회 자동 업데이트 확인(로그인 상태와 무관, 네트워크 비동기)
boot().then(autoCheckUpdateOnce)
