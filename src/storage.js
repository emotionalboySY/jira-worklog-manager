// localStorage 래퍼 (세션/연반차/즐겨찾기/캐시/사용자 설정)
import {
  state,
  SESSIONS_KEY,
  DAY_OFFS_KEY,
  FAVORITES_KEY,
  ISSUES_CACHE_KEY,
  WORKLOG_CACHE_KEY,
  WORKLOG_CACHE_MAX_MONTHS,
  PREFERENCES_KEY,
  DEFAULT_STATUS_ORDER,
  DEFAULT_PROJECT_ORDER,
  DEFAULT_PROJECT_COLORS,
  DEFAULT_SUMMARY_WEEK_START,
} from './state.js'
import { calcLunchOverlap } from './utils.js'

// ========== 세션 관리 (segments 기반) ==========
// 세션 구조: { issueKey, summary, status, segments: [{ start, end }] }
// segments: 실제 작업한 구간 목록. end=null이면 현재 진행 중
export function loadSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    if (!raw) return []
    return JSON.parse(raw).map(s => ({
      ...s,
      segments: (s.segments || []).map(seg => ({
        start: new Date(seg.start),
        end: seg.end ? new Date(seg.end) : null,
      })),
    }))
  } catch { return [] }
}

export function saveSessions(sessions) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
}

// 현재 active 세션의 마지막 segment를 닫음
export function pauseActiveSession(sessions) {
  const active = sessions.find(s => s.status === 'active')
  if (active) {
    active.status = 'paused'
    const lastSeg = active.segments[active.segments.length - 1]
    if (lastSeg && !lastSeg.end) lastSeg.end = new Date()
  }
}

export function addSession(issueKey, summary) {
  const sessions = loadSessions()
  const existing = sessions.find(s => s.issueKey === issueKey)
  if (existing) {
    // 이미 세션이 있으면 재개
    if (existing.status === 'paused') {
      pauseActiveSession(sessions)
      existing.status = 'active'
      existing.segments.push({ start: new Date(), end: null })
    }
    saveSessions(sessions)
    return true
  }
  // 기존 active 세션 자동 중단
  pauseActiveSession(sessions)
  sessions.push({
    issueKey,
    summary,
    status: 'active',
    segments: [{ start: new Date(), end: null }],
  })
  saveSessions(sessions)
  return true
}

export function pauseSession(issueKey) {
  const sessions = loadSessions()
  const s = sessions.find(s => s.issueKey === issueKey)
  if (!s || s.status !== 'active') return
  s.status = 'paused'
  const lastSeg = s.segments[s.segments.length - 1]
  if (lastSeg && !lastSeg.end) lastSeg.end = new Date()
  saveSessions(sessions)
}

export function resumeSession(issueKey) {
  const sessions = loadSessions()
  const s = sessions.find(s => s.issueKey === issueKey)
  if (!s || s.status !== 'paused') return
  // 기존 active 세션 자동 중단
  pauseActiveSession(sessions)
  s.status = 'active'
  s.segments.push({ start: new Date(), end: null })
  saveSessions(sessions)
}

export function removeSession(issueKey) {
  const sessions = loadSessions().filter(s => s.issueKey !== issueKey)
  saveSessions(sessions)
}

// 세션의 첫 시작 시각
export function getSessionStartedAt(session) {
  return session.segments.length > 0 ? session.segments[0].start : new Date()
}

// 세션 총 활성 시간 (분)
export function getSessionElapsedMinutes(session) {
  let totalMs = 0
  for (const seg of session.segments) {
    const end = seg.end || new Date()
    totalMs += end.getTime() - seg.start.getTime()
  }
  return Math.floor(totalMs / 60000)
}

// 구간별 정보 (종료 모달용)
export function getSegmentDetails(session) {
  return session.segments.map(seg => {
    const start = seg.start
    const end = seg.end || new Date()
    const durationMinutes = Math.floor((end.getTime() - start.getTime()) / 60000)
    const lunchMinutes = calcLunchOverlap(start, end)
    return {
      start,
      end,
      durationMinutes,
      lunchMinutes,
      actualMinutes: Math.max(0, durationMinutes - lunchMinutes),
    }
  })
}

// ========== 연반차 ==========
// type: 'full' (종일 연차) | 'am' (오전 반차) | 'pm' (오후 반차) | null
export function loadDayOffs() {
  try {
    const raw = localStorage.getItem(DAY_OFFS_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : {}
  } catch { return {} }
}

export function getDayOff(dateStr) {
  return loadDayOffs()[dateStr] || null
}

export function setDayOff(dateStr, type) {
  const m = loadDayOffs()
  if (!type || type === 'none') delete m[dateStr]
  else m[dateStr] = type
  try { localStorage.setItem(DAY_OFFS_KEY, JSON.stringify(m)) } catch {}
}

// 연반차 상태를 근무 시간(분)으로 환산: 연차 8시간, 반차 4시간
export function getDayOffMinutes(type) {
  if (type === 'full') return 480
  if (type === 'am' || type === 'pm') return 240
  return 0
}

export function getDayOffLabel(type) {
  if (type === 'full') return '연차'
  if (type === 'am') return '오전 반차'
  if (type === 'pm') return '오후 반차'
  return ''
}

// ========== 즐겨찾는 이슈 ==========
export function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

export function saveFavorites(list) {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(list)) } catch {}
}

export function isFavorite(issueKey) {
  return loadFavorites().some(f => f.issueKey === issueKey)
}

export function toggleFavorite(issueKey, summary) {
  const list = loadFavorites()
  const idx = list.findIndex(f => f.issueKey === issueKey)
  if (idx >= 0) {
    list.splice(idx, 1)
  } else {
    list.push({ issueKey, summary })
  }
  saveFavorites(list)
}

// ========== 이슈 캐시 ==========
export function loadIssuesCache() {
  try {
    const raw = localStorage.getItem(ISSUES_CACHE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch { return null }
}

export function saveIssuesCache(issues, projects) {
  try {
    localStorage.setItem(ISSUES_CACHE_KEY, JSON.stringify({ issues, projects, savedAt: Date.now() }))
  } catch (e) {
    console.warn('이슈 캐시 저장 실패:', e)
  }
}

// ========== 워크로그 캐시 ==========
export function loadWorklogCache() {
  try {
    const raw = localStorage.getItem(WORKLOG_CACHE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch { return null }
}

export function saveWorklogCache(monthKey, logs) {
  const cache = loadWorklogCache() || { months: {} }
  // 해당 월 데이터 저장
  cache.months[monthKey] = { data: logs, savedAt: Date.now() }
  // 최근 N개월만 유지 — 오래된 월 삭제
  const keys = Object.keys(cache.months).sort()
  while (keys.length > WORKLOG_CACHE_MAX_MONTHS) {
    delete cache.months[keys.shift()]
  }
  try {
    localStorage.setItem(WORKLOG_CACHE_KEY, JSON.stringify(cache))
  } catch (e) {
    console.warn('워크로그 캐시 저장 실패:', e)
  }
}

export function getCachedMonth(monthKey) {
  const cache = loadWorklogCache()
  return cache?.months?.[monthKey]?.data || null
}

// 캐시 데이터를 worklogsByDate에 병합
export function mergeLogs(logs) {
  for (const [date, entries] of Object.entries(logs)) {
    state.worklogsByDate[date] = entries
  }
}

// ========== 사용자 설정 (정렬 순서/프로젝트 색상) ==========
function defaultPreferences() {
  return {
    statusOrder: [...DEFAULT_STATUS_ORDER],
    projectOrder: [...DEFAULT_PROJECT_ORDER],
    projectColors: JSON.parse(JSON.stringify(DEFAULT_PROJECT_COLORS)),
    summaryWeekStart: DEFAULT_SUMMARY_WEEK_START,
  }
}

export function loadPreferences() {
  const defaults = defaultPreferences()
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY)
    if (!raw) return defaults
    const saved = JSON.parse(raw)
    // 방어적 병합: 저장 이후 기본값에 새 항목이 추가된 경우도 수용
    const merged = {
      statusOrder: Array.isArray(saved.statusOrder) && saved.statusOrder.length
        ? mergeOrder(saved.statusOrder, DEFAULT_STATUS_ORDER)
        : defaults.statusOrder,
      projectOrder: Array.isArray(saved.projectOrder) && saved.projectOrder.length
        ? mergeOrder(saved.projectOrder, DEFAULT_PROJECT_ORDER)
        : defaults.projectOrder,
      projectColors: { ...defaults.projectColors, ...(saved.projectColors || {}) },
      summaryWeekStart: (saved.summaryWeekStart === 'monday' || saved.summaryWeekStart === 'thursday')
        ? saved.summaryWeekStart
        : defaults.summaryWeekStart,
    }
    return merged
  } catch {
    return defaults
  }
}

// 저장된 순서 뒤에 기본값에서 새로 추가된 항목 append
function mergeOrder(saved, defaultsArr) {
  const seen = new Set(saved)
  const extras = defaultsArr.filter(x => !seen.has(x))
  return [...saved, ...extras]
}

export function savePreferences(prefs) {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(prefs))
  } catch (e) {
    console.warn('설정 저장 실패:', e)
  }
}

export function resetPreferences() {
  const d = defaultPreferences()
  savePreferences(d)
  return d
}
