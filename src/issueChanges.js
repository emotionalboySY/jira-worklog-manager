// 웹훅/폴링으로 감지된 이슈 변경을 토스트로 알리고, 별도 모달에서 볼 수 있도록
// 쌓아 두는 변경 알림 저장소. issueFlash.js(행 강조)와 짝을 이룬다 — actions.js가
// 변경을 감지하면 markIssuesFlashing(강조)과 recordIssueChanges(알림)를 함께 호출한다.
//
// 저장소는 localStorage에 영속화되어(사용자별) 새로고침 후에도 기록이 유지된다.
import { showToast } from './ui.js'
import { josaRo } from './utils.js'

const LOG_KEY = 'issue_changes_log'
const READ_KEY = 'issue_changes_read_at'
const MAX_ENTRIES = 100          // 저장 상한 (초과 시 오래된 것부터 버림)
const DEDUP_MS = 12 * 1000       // 같은 변경 중복 억제 창(웹훅+폴링, 내 일감+백로그 이중 트리거 방어)
const INDIVIDUAL_TOAST_CAP = 4   // 한 번에 이보다 많이 바뀌면 개별 토스트 대신 요약 1건

// 각 항목: { key, kind: 'status'|'description'|'generic', from, to, at(ms) }
const log = loadLog()
let lastReadAt = Number(localStorage.getItem(READ_KEY)) || 0

function loadLog() {
  try {
    const raw = localStorage.getItem(LOG_KEY)
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr
    }
  } catch {}
  return []
}

function persist() {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(log)) } catch {}
}

// 토스트/모달에 쓰는 사람 읽기용 메시지.
export function buildChangeMessage(e) {
  const key = e.key || ''
  if (e.kind === 'status') {
    const to = e.to || '?'
    return `${key} 항목의 상태가 ${e.from || '?'}에서 ${to}${josaRo(to)} 변경되었습니다.`
  }
  if (e.kind === 'description') {
    return `${key} 항목의 설명이 변경되었습니다.`
  }
  return `${key} 항목에 변경된 요소가 있습니다.`
}

// 최근 DEDUP_MS 안에 같은 (키·종류·전·후) 변경이 이미 기록됐는지.
function isRecentDuplicate(c, now) {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]
    if (now - e.at > DEDUP_MS) break // 시간순 정렬이라 더 과거는 볼 필요 없음
    if (e.key === c.key
      && e.kind === (c.kind || 'generic')
      && (e.from || '') === (c.from || '')
      && (e.to || '') === (c.to || '')) return true
  }
  return false
}

function showChangeToasts(entries) {
  if (entries.length <= INDIVIDUAL_TOAST_CAP) {
    for (const e of entries) showToast(buildChangeMessage(e), '🔔')
  } else {
    showToast(`${entries.length}개 항목이 변경되었습니다.`, '🔔')
  }
}

// 변경 목록을 기록 + 토스트. changes: [{ key, kind, from, to }]
// 중복(웹훅+폴링 등)은 걸러내고, 실제로 새로 쌓인 것만 토스트한다.
export function recordIssueChanges(changes) {
  if (!Array.isArray(changes) || !changes.length) return
  const now = Date.now()
  const fresh = []
  for (const c of changes) {
    if (!c || !c.key) continue
    if (isRecentDuplicate(c, now)) continue
    const entry = { key: c.key, kind: c.kind || 'generic', from: c.from || '', to: c.to || '', at: now }
    log.push(entry)
    fresh.push(entry)
  }
  if (!fresh.length) return
  if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES)
  persist()
  showChangeToasts(fresh)
}

// 모달용: 최신순 목록 사본.
export function getChangeLog() {
  return log.slice().reverse()
}

// FAB 배지용: 아직 안 읽은(마지막 열람 이후) 변경 수.
export function getUnreadChangeCount() {
  if (!lastReadAt) return log.length
  let n = 0
  for (const e of log) if (e.at > lastReadAt) n++
  return n
}

// 모달을 열 때 호출 — 이후 배지는 0.
export function markChangesRead() {
  lastReadAt = Date.now()
  try { localStorage.setItem(READ_KEY, String(lastReadAt)) } catch {}
}

// 기록 전체 삭제 (모달의 '기록 지우기').
export function clearChangeLog() {
  log.length = 0
  lastReadAt = Date.now()
  persist()
  try { localStorage.setItem(READ_KEY, String(lastReadAt)) } catch {}
}
