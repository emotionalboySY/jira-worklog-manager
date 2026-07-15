// 세션 백엔드 동기 계층 — /api/sessions 와 통신.
//
// 역할:
//  - 낙관적 변이(storage.js에서 로컬 캐시 선반영) 후 백엔드로 동기(queueSessionSync)
//  - 변이 큐 + 단일 드레이너: 네트워크 오류 시 보류 후 재시도(오프라인 내성)
//  - 2.5초 폴링으로 다른 기기/위젯의 변경을 근실시간 반영
//  - 권위 상태(rev) 기준 재조정: rev가 더 클 때만 로컬 캐시 교체
//
// import 순환을 피하려고 state.js 의 키 상수만 import하고, render는 훅으로 주입받는다.
// (storage.js → sessionSync.js → state.js 로만 흐르고 되돌아가지 않음)
// utils.js는 state.js/lib만 import하므로 순환 없음.
import { SESSIONS_KEY, state } from './state.js'
import { isBusyUI } from './utils.js'
// auth.js는 leaf 모듈(다른 src 모듈을 import하지 않음)이라 순환 없음.
import { ensureAccessToken, refreshAccessToken } from './auth.js'

const API = '/api/sessions'
// 적응형 폴링 간격: 활성 세션이 있으면 짧게(반응성), 유휴면 길게(요청량 절약).
const POLL_ACTIVE_MS = 3000
const POLL_IDLE_MS = 12000

// 렌더 훅 (main.js가 setSessionRenderHook(render)로 주입)
let _render = () => {}
export function setSessionRenderHook(fn) { if (typeof fn === 'function') _render = fn }

// ===== Jira 웹훅 변경 감지 =====
// 웹훅 수신 시 서버가 changes 카운터를 올리고, 세션 폴 응답에 jiraRev로 실어 보낸다.
// jiraRev가 증가하면(다른 곳에서 내 이슈가 바뀜) 이슈/워크로그 재로드 훅을 호출한다.
// import 순환을 피하려 실제 재로드는 main.js가 setJiraChangeHook으로 주입한다.
let _jiraChangeHook = null
export function setJiraChangeHook(fn) { if (typeof fn === 'function') _jiraChangeHook = fn }
let lastJiraRev = -1 // -1: 기준값 미설정(첫 관측은 기준선으로만 삼고 재로드하지 않음)

function handleJiraRev(data) {
  if (!data || typeof data.jiraRev !== 'number') return
  const rev = data.jiraRev
  if (lastJiraRev === -1) { lastJiraRev = rev; return } // 최초 관측 = 기준선
  if (rev <= lastJiraRev) return
  // 입력 중(모달/드롭다운 등)이면 기준값을 올리지 않고 다음 틱으로 미룬다 → 입력값 보존.
  if (isBusyUI()) return
  lastJiraRev = rev
  try { if (_jiraChangeHook) _jiraChangeHook() } catch (e) { console.error('Jira 변경 재로드 실패:', e) }
}

function authToken() { return localStorage.getItem('jira_access_token') }

// ===== 로컬 캐시 (localStorage 'work_sessions' — storage.js와 공유) =====
function loadCacheRaw() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}
function saveCacheRaw(sessions) {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions)) } catch {}
}

// ===== 권위 상태 (rev) =====
// 마지막으로 반영한 권위 rev. rev가 이보다 클 때만 캐시를 교체한다.
// (rev 동일 → 같은 버전이므로 로컬의 요약 갱신 등 비-변이 수정 보존)
let localRev = 0

function applyAuthoritative(data) {
  if (!data || typeof data.rev !== 'number' || !Array.isArray(data.sessions)) return false
  if (data.rev <= localRev) return false
  const changed = JSON.stringify(loadCacheRaw()) !== JSON.stringify(data.sessions)
  saveCacheRaw(data.sessions)
  localRev = data.rev
  if (changed) {
    // 모달/드롭다운 등 입력 중 UI가 떠 있으면 전체 렌더가 DOM에만 있는 입력값
    // (종료 모달 시간/코멘트 등)을 날리므로 세션 영역만 갱신한다.
    // 캐시는 위에서 이미 권위 상태로 교체됐고, 모달 제출부는 제출 시점에 다시 읽는다.
    if (isBusyUI()) _render({ sections: ['sessions'] })
    else _render()
  }
  return changed
}

// ===== API =====
// 요청 전 ensureAccessToken으로 만료 임박 토큰을 선제 갱신하고, 그래도 401이면(서버측
// 무효화 등) 1회 refresh 후 재시도한다. 이 경로가 없어 폴링이 만료 토큰으로 401을 무한
// 반복하던 문제(콘솔 401 누적)를 막는다.
async function apiGet() {
  const token = await ensureAccessToken()
  if (!token) { const e = new Error('GET 401'); e.status = 401; throw e }
  let res = await fetch(API, { headers: { Authorization: `Bearer ${token}` } })
  if (res.status === 401 && await refreshAccessToken()) {
    res = await fetch(API, { headers: { Authorization: `Bearer ${authToken()}` } })
  }
  if (!res.ok) { const e = new Error(`GET ${res.status}`); e.status = res.status; throw e }
  return res.json() // { sessions, rev }
}
async function apiPost(action, payload) {
  const token = await ensureAccessToken()
  if (!token) return { status: 401, data: null }
  const send = (t) => fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify({ action, payload }),
  })
  let res = await send(token)
  if (res.status === 401 && await refreshAccessToken()) {
    res = await send(authToken())
  }
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data }
}

// ===== 변이 큐 + 드레이너 =====
// storage.js가 로컬 캐시를 선반영한 뒤 이 함수를 호출(fire-and-forget).
// 큐에 쌓아 순서대로 백엔드에 반영하고, 네트워크 오류 시 보류 후 재시도.
let queue = []
let draining = false

export function queueSessionSync(action, payload) {
  queue.push({ action, payload })
  drain()
}

export function hasPendingSync() { return queue.length > 0 }

async function drain() {
  if (draining) return
  if (!authToken()) return
  draining = true
  try {
    while (queue.length) {
      const { action, payload } = queue[0]
      let resp
      try {
        resp = await apiPost(action, payload)
      } catch (e) {
        // 네트워크 오류 → 큐에 남겨두고 중단(다음 변이/폴링 틱에서 재시도)
        console.warn('세션 동기 네트워크 오류, 재시도 대기:', e?.message)
        break
      }
      if (resp.status === 200 || resp.status === 409) {
        queue.shift()
        applyAuthoritative(resp.data)
      } else if (resp.status === 401) {
        // 인증 만료 — 큐 비우고 중단(로그아웃 흐름이 UI 전환 담당)
        console.warn('세션 동기 401 — 보류 큐 비움')
        queue = []
        break
      } else {
        // 4xx(검증 실패 등) — 해당 항목 폐기 후 서버 상태로 보정
        console.warn('세션 동기 거부:', resp.status, resp.data)
        queue.shift()
        if (resp.data) applyAuthoritative(resp.data)
      }
    }
  } finally {
    draining = false
  }
}

// ===== 폴링 =====
let polling = false
let pollTimer = null

function scheduleNext() {
  clearTimeout(pollTimer)
  const hasActive = loadCacheRaw().some(s => s.status === 'active')
  // 알림 패널을 열어 변경을 실시간으로 지켜보는 중이면 빠른 주기로 폴링(밀림 방지).
  const fast = hasActive || state.showChangeLog
  pollTimer = setTimeout(pollTick, fast ? POLL_ACTIVE_MS : POLL_IDLE_MS)
}

// 다음 예약 틱을 앞당겨 즉시 1회 폴링한다(예약된 유휴 12초 대기 회피).
// 알림 패널을 열 때 호출해 최신 변경을 바로 반영한다.
export function nudgeSessionPoll() {
  if (!polling) return
  clearTimeout(pollTimer)
  pollTimer = setTimeout(pollTick, 0)
}

async function pollTick() {
  if (!polling) return
  try {
    if (!authToken()) return
    // 보류 중인 변이가 있으면 GET으로 덮어쓰지 말고 먼저 드레인(재시도)
    if (hasPendingSync()) { await drain(); return }
    // 비용 절약: 창이 숨겨져 있고 활성 세션도 없으면 이번 틱은 건너뜀
    const hasActive = loadCacheRaw().some(s => s.status === 'active')
    if (typeof document !== 'undefined' && document.hidden && !hasActive) return
    const data = await apiGet()
    applyAuthoritative(data)
    handleJiraRev(data) // 웹훅 변경 감지 → 필요 시 이슈/워크로그 재로드
  } catch (e) {
    // 일시 오류는 무시하고 다음 틱에 재시도
  } finally {
    if (polling) scheduleNext()
  }
}

function startPolling() {
  if (polling) return
  polling = true
  scheduleNext()
}

// 로그인 직후 1회 호출: 백엔드 상태 채택(또는 로컬→백엔드 마이그레이션 시드) 후 폴링 시작.
export async function initSessionSync() {
  if (!authToken()) return
  try {
    const data = await apiGet()
    handleJiraRev(data) // 최초 관측 → jiraRev 기준선 설정(로그인 직후엔 재로드 안 함)
    const backendEmpty = data.rev === 0 && (!data.sessions || data.sessions.length === 0)
    const local = loadCacheRaw()
    if (backendEmpty && local.length > 0) {
      // 마이그레이션: 기존 localStorage 세션을 백엔드에 시드. 실패 시 로컬 유지(덮어쓰지 않음).
      const seeded = await apiPost('replaceAll', { sessions: local })
      if (seeded.status === 200) applyAuthoritative(seeded.data)
      else console.warn('세션 마이그레이션 시드 실패(로컬 유지):', seeded.status)
    } else {
      applyAuthoritative(data)
    }
  } catch (e) {
    console.warn('세션 초기 동기 실패(로컬 캐시 사용):', e?.message)
  }
  startPolling()
}

// 로그아웃 시: 폴링 중단 + 동기 상태 초기화. (로컬 캐시는 기존 동작과 동일하게 유지)
export function stopSessionPolling() {
  polling = false
  clearTimeout(pollTimer)
  pollTimer = null
  queue = []
  localRev = 0
  lastJiraRev = -1 // 재로그인 시 다시 기준선부터
}
