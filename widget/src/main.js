// DK 워크로그 위젯 — 엔트리.
// 로그인(데스크톱 OAuth) → 오늘 합계 + 진행 중 세션 표시(경과시계 1초 틱) → 폴링 동기 + 중단/재개.
// 새 일감 시작/전환은 웹앱에서, 종료(코멘트 입력)는 다음 단계에서 추가.
import { getCurrentWindow } from '@tauri-apps/api/window'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { listen } from '@tauri-apps/api/event'
import { isLoggedIn, login } from './auth.js'
import { getSessions, postSessionAction, getTodayLoggedMinutes } from './api.js'

const appWindow = getCurrentWindow()
let alwaysOnTop = true

const state = {
  phase: 'loading',     // 'loading' | 'login' | 'ready' | 'error'
  error: null,
  todayMinutes: 0,
  sessions: [],
  rev: 0,
  busy: false,          // 컨트롤 동작 중
  notice: null,         // 일시 안내 메시지
}

let pollTimer = null
let tickTimer = null
let todayTimer = null

// ===== 시간 헬퍼 (백엔드가 권위, 여기선 표시용 계산만) =====
function elapsedMs(session, nowMs) {
  let total = 0
  for (const seg of session.segments || []) {
    const end = seg.end ? Date.parse(seg.end) : nowMs
    total += end - Date.parse(seg.start)
  }
  return Math.max(0, total)
}
function fmtMinutes(min) {
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m}분`
  if (m === 0) return `${h}시간`
  return `${h}시간 ${m}분`
}
function fmtClock(ms) {
  const s = Math.floor(ms / 1000)
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}
function activeSession() {
  return state.sessions.find(s => s.status === 'active') || null
}
function pausedSessions() {
  return state.sessions.filter(s => s.status === 'paused')
}
const NO_ISSUE_KEY = '__NO_ISSUE__'

// ===== 렌더 =====
function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function render() {
  const app = document.getElementById('app')
  app.innerHTML = `
    <div class="widget">
      <div class="widget-header" data-tauri-drag-region>
        <span class="widget-title" data-tauri-drag-region>DK 워크로그</span>
        <div class="widget-win-buttons">
          <button class="win-btn" id="btn-pin" title="항상 위 고정">${alwaysOnTop ? '📌' : '📍'}</button>
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
  const todayLabel = fmtMinutes(state.todayMinutes + (act ? Math.floor(elapsedMs(act, Date.now()) / 60000) : 0))

  let sessionHtml
  if (act) {
    const isNoIssue = act.issueKey === NO_ISSUE_KEY
    sessionHtml = `
      <div class="session active">
        <div class="session-issue">
          <span class="dot live"></span>
          <span class="issue-key">${isNoIssue ? '(일감 미지정)' : escapeHtml(act.issueKey)}</span>
          <span class="issue-summary">${escapeHtml(act.summary)}</span>
        </div>
        <div class="session-row">
          <span class="clock" id="clock" data-key="${escapeHtml(act.issueKey)}">${fmtClock(elapsedMs(act, Date.now()))}</span>
          <div class="ctrls">
            <button class="btn-sm" data-act="pause" data-key="${escapeHtml(act.issueKey)}" ${state.busy ? 'disabled' : ''}>중단</button>
            <button class="btn-sm btn-finish" data-act="finish" data-key="${escapeHtml(act.issueKey)}" ${state.busy ? 'disabled' : ''}>종료</button>
          </div>
        </div>
      </div>`
  } else if (paused.length) {
    const p = paused[0]
    const isNoIssue = p.issueKey === NO_ISSUE_KEY
    sessionHtml = `
      <div class="session paused">
        <div class="session-issue">
          <span class="dot"></span>
          <span class="issue-key">${isNoIssue ? '(일감 미지정)' : escapeHtml(p.issueKey)}</span>
          <span class="issue-summary">${escapeHtml(p.summary)}</span>
        </div>
        <div class="session-row">
          <span class="clock paused-clock">${fmtClock(elapsedMs(p, Date.now()))} · 중단됨</span>
          <div class="ctrls">
            <button class="btn-sm" data-act="resume" data-key="${escapeHtml(p.issueKey)}" ${state.busy ? 'disabled' : ''}>재개</button>
            <button class="btn-sm btn-finish" data-act="finish" data-key="${escapeHtml(p.issueKey)}" ${state.busy ? 'disabled' : ''}>종료</button>
          </div>
        </div>
      </div>`
  } else {
    sessionHtml = `<div class="placeholder">진행 중인 작업이 없습니다.<br/><span class="dim">웹앱에서 작업을 시작하세요.</span></div>`
  }

  return `
    <div class="today"><span class="today-label">오늘</span><span class="today-val">${todayLabel}</span></div>
    ${sessionHtml}
    ${state.notice ? `<div class="notice">${escapeHtml(state.notice)}</div>` : ''}
  `
}

// ===== 이벤트 =====
function bindCommon() {
  document.getElementById('btn-pin')?.addEventListener('click', async () => {
    alwaysOnTop = !alwaysOnTop
    try { await appWindow.setAlwaysOnTop(alwaysOnTop) } catch (e) { console.error(e) }
    render()
  })
  document.getElementById('btn-hide')?.addEventListener('click', () => appWindow.hide().catch(console.error))
  document.getElementById('btn-close')?.addEventListener('click', () => appWindow.close().catch(console.error))
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
  state.busy = true; render()
  try {
    const { status, data } = await postSessionAction(action, { issueKey: key, nowMs: Date.now() })
    if ((status === 200 || status === 409) && data) {
      state.sessions = data.sessions || []
      state.rev = data.rev || state.rev
    }
  } catch (e) {
    console.error('동작 실패:', e)
  } finally {
    state.busy = false
    render()
  }
}

// 종료 다이얼로그(별도 작은 창) 열기. 이미 떠 있으면 포커스만.
async function openFinishDialog(key) {
  try {
    const existing = await WebviewWindow.getByLabel('finish')
    if (existing) { await existing.setFocus(); return }
  } catch {}
  const w = new WebviewWindow('finish', {
    url: `finish.html?key=${encodeURIComponent(key)}`,
    title: '작업 종료',
    width: 380,
    height: 250,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    decorations: true,
    skipTaskbar: true,
  })
  w.once('tauri://error', (e) => console.error('finish 창 생성 오류:', e))
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
  const [sess, today] = await Promise.allSettled([getSessions(), getTodayLoggedMinutes()])
  if (sess.status === 'fulfilled') {
    state.sessions = sess.value.sessions || []
    state.rev = sess.value.rev || 0
  } else {
    throw sess.reason
  }
  if (today.status === 'fulfilled') state.todayMinutes = today.value
  state.phase = 'ready'
  state.error = null
  render()
}

function pollDelay() {
  return activeSession() ? 3000 : 10000
}
function startPolling() {
  stopPolling()
  const tick = async () => {
    try {
      const data = await getSessions()
      if ((data.rev || 0) >= state.rev) {
        const changed = JSON.stringify(state.sessions) !== JSON.stringify(data.sessions)
        state.sessions = data.sessions || []
        state.rev = data.rev || 0
        if (changed) render()
      }
    } catch (e) {
      if (e.code === 'unauthorized' || e.code === 'not-authed') { handleLogout(); return }
    }
    pollTimer = setTimeout(tick, pollDelay())
  }
  pollTimer = setTimeout(tick, pollDelay())
  // 오늘 합계는 1분마다 갱신(종료 시점 외엔 거의 안 변함)
  todayTimer = setInterval(async () => {
    try { state.todayMinutes = await getTodayLoggedMinutes() } catch {}
  }, 60000)
}
function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
  if (todayTimer) { clearInterval(todayTimer); todayTimer = null }
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

boot()
