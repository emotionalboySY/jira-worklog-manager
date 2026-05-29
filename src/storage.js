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
import {
  applyStart,
  applyPause,
  applyResume,
  applyRemove,
  applyDeleteSegment,
  applySwap,
} from '../lib/sessionLogic.js'

// ========== 세션 관리 (segments 기반) ==========
// 세션 구조: { issueKey, summary, status, segments: [{ start, end }] }
// segments: 실제 작업한 구간 목록. end=null이면 현재 진행 중
//
// 변이 규칙(시작/중단/재개/삭제/교체 + 1분 미만 구간 병합)은 모두
// ../lib/sessionLogic.js 의 순수 함수에 위임한다. 이 파일은 localStorage 입출력 +
// UI용 Date 복원 경계만 담당한다(서버리스/위젯과 동일 로직 공유).

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

// 변이 로직에 넘길 "원본"(ISO 문자열 그대로, Date 변환 X) 세션 배열을 읽는다.
// loadSessions는 UI 소비용으로 Date를 복원하지만, sessionLogic은 ISO 문자열을 받는다.
function loadRawSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

// 아래 변이 함수들은 모두 ../lib/sessionLogic.js 의 순수 함수에 위임한다.
//   loadRawSessions(ISO) → applyX(...) → saveSessions(결과)
// saveSessions는 JSON.stringify만 하므로 ISO 문자열 세션도 그대로 안전하게 저장된다.

export function addSession(issueKey, summary) {
  const { sessions } = applyStart(loadRawSessions(), { issueKey, summary }, Date.now())
  saveSessions(sessions)
  return true
}

export function pauseSession(issueKey) {
  const { sessions } = applyPause(loadRawSessions(), { issueKey }, Date.now())
  saveSessions(sessions)
}

export function resumeSession(issueKey) {
  const { sessions } = applyResume(loadRawSessions(), { issueKey }, Date.now())
  saveSessions(sessions)
}

export function removeSession(issueKey) {
  const { sessions } = applyRemove(loadRawSessions(), { issueKey })
  saveSessions(sessions)
}

// 세션의 특정 구간을 삭제. 마지막 남은 1구간은 삭제 불가(세션 전체 삭제는 '취소'로).
// active 세션에서 열린 구간(end=null)을 삭제한 경우 paused로 전환.
export function deleteSessionSegment(issueKey, segIdx) {
  const r = applyDeleteSegment(loadRawSessions(), { issueKey, segIdx })
  if (r.ok) saveSessions(r.sessions)
  return { ok: r.ok, error: r.error }
}

// 세션의 이슈 키/요약을 교체. segments/status는 유지.
// 대상 키의 세션이 이미 존재하면 실패 (병합은 복잡도 커서 지원 안 함).
export function swapSessionIssue(oldKey, newKey, newSummary) {
  const r = applySwap(loadRawSessions(), { oldKey, newKey, newSummary })
  if (r.ok && !r.unchanged) saveSessions(r.sessions)
  return { ok: r.ok, unchanged: r.unchanged, error: r.error }
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
// isFavorite는 이슈 행마다 호출되므로(50행 = 50번 localStorage 읽기) 키 Set만 별도 캐시.
// loadFavorites/saveFavorites 자체는 호출자가 mutate 후 saveFavorites로 저장하는 패턴이라
// 캐싱하면 의도치 않은 공유가 발생할 수 있어 손대지 않음.
let _favoriteKeySet = null

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
  _favoriteKeySet = null  // 다음 isFavorite 호출 시 재구축
}

export function isFavorite(issueKey) {
  if (_favoriteKeySet === null) {
    _favoriteKeySet = new Set(loadFavorites().map(f => f.issueKey))
  }
  return _favoriteKeySet.has(issueKey)
}

// 이슈 목록(freshIssues)을 기준으로 세션·즐겨찾기의 summary를 일괄 동기화.
// 일감 리스트 새로고침 직후 호출해, 다른 곳에서(웹 Jira 등) 변경된 제목을
// 현재 작업/즐겨찾기 카드에 반영한다. 매칭되지 않는 키는 손대지 않는다.
// 반환: 실제 변경이 있었는지 여부 (호출자가 재렌더 트리거 판단용으로 활용 가능)
export function syncIssueSummariesFromList(freshIssues) {
  if (!Array.isArray(freshIssues) || freshIssues.length === 0) return false
  const summaryByKey = new Map()
  for (const issue of freshIssues) {
    if (issue && issue.key) summaryByKey.set(issue.key, issue.summary || '')
  }
  // 세션
  const sessions = loadSessions()
  let sessionsChanged = false
  for (const s of sessions) {
    if (!summaryByKey.has(s.issueKey)) continue
    const fresh = summaryByKey.get(s.issueKey)
    if (s.summary !== fresh) {
      s.summary = fresh
      sessionsChanged = true
    }
  }
  if (sessionsChanged) saveSessions(sessions)
  // 즐겨찾기
  const favs = loadFavorites()
  let favsChanged = false
  for (const f of favs) {
    if (!summaryByKey.has(f.issueKey)) continue
    const fresh = summaryByKey.get(f.issueKey)
    if (f.summary !== fresh) {
      f.summary = fresh
      favsChanged = true
    }
  }
  if (favsChanged) saveFavorites(favs)
  return sessionsChanged || favsChanged
}

// 특정 이슈 키의 요약 텍스트를 세션·즐겨찾기 저장소에 모두 반영
export function updateIssueSummaryEverywhere(issueKey, newSummary) {
  if (!issueKey) return
  // 세션
  const sessions = loadSessions()
  let sessionsChanged = false
  for (const s of sessions) {
    if (s.issueKey === issueKey && s.summary !== newSummary) {
      s.summary = newSummary || ''
      sessionsChanged = true
    }
  }
  if (sessionsChanged) saveSessions(sessions)
  // 즐겨찾기
  const favs = loadFavorites()
  let favsChanged = false
  for (const f of favs) {
    if (f.issueKey === issueKey && f.summary !== newSummary) {
      f.summary = newSummary || ''
      favsChanged = true
    }
  }
  if (favsChanged) saveFavorites(favs)
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

// 특정 이슈를 즐겨찾기에서 제거. 제거됐는지 여부 반환(상태 변화 시 재렌더 트리거용).
export function removeFavorite(issueKey) {
  const list = loadFavorites()
  const idx = list.findIndex(f => f.issueKey === issueKey)
  if (idx < 0) return false
  list.splice(idx, 1)
  saveFavorites(list)
  return true
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
