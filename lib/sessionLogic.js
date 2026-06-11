// ========== 작업 세션 변이 규칙 (순수 모듈) ==========
// 웹앱(src/storage.js) · 서버리스(api/sessions.js) · 데스크톱 위젯이 공유하는
// "단일 변이 로직". 브라우저/Node 어디서나 동작하도록 외부 의존성이 전혀 없다.
//
// 세션 캐논 모델 (타임스탬프는 ISO 문자열):
//   { issueKey, summary, status: 'active'|'paused', segments: [{ start: ISO, end: ISO|null }] }
//   - status 'active' + 마지막 segment.end === null  → 현재 진행 중
//   - end === null 인 구간은 "열린 구간"
//
// 모든 apply* 함수는 입력 배열을 변형하지 않고 새 배열을 반환한다(불변).
// "현재 시각"이 필요한 함수는 nowMs를 인자로 받아 서버/클라가 동일하게 동작한다.

// 1분 미만의 짧은 활동은 별도 구간으로 기록하지 않고 합치거나 버린다.
// - 재개: 직전 구간을 이어서 (새 구간 push 하지 않음)
// - 다른 일감 시작: 현재 active 구간이 1분 미만이면 마지막 구간을 제거
//   (유일 구간이면 세션 전체 삭제 = 일감 변경과 동일)
export const SEGMENT_MERGE_THRESHOLD_MS = 60 * 1000

// 입력 세션 배열을 안전하게 깊은 복제 (segments까지). 알 수 없는 잉여 필드는 버려 정규화.
function clone(sessions) {
  if (!Array.isArray(sessions)) return []
  return sessions.map(s => ({
    issueKey: s.issueKey,
    summary: s.summary || '',
    status: s.status === 'active' ? 'active' : 'paused',
    segments: Array.isArray(s.segments)
      ? s.segments.map(seg => ({ start: seg.start, end: seg.end != null ? seg.end : null }))
      : [],
  }))
}

const ms = (isoStr) => Date.parse(isoStr)
const iso = (msVal) => new Date(msVal).toISOString()

// 현재 active 세션의 마지막 segment를 닫음.
// 단, 마지막 구간이 시작된 지 1분 미만이면 그 구간을 기록 없이 버린다.
// (짧은 오클릭/빠른 전환을 "일감 변경"처럼 처리 — 유일 구간이면 세션 전체 삭제)
// next 배열을 in-place로 수정한다(호출부가 이미 clone한 배열을 넘김).
function pauseActive(next, nowMs) {
  const idx = next.findIndex(s => s.status === 'active')
  if (idx < 0) return
  const active = next[idx]
  const lastSeg = active.segments[active.segments.length - 1]
  if (!lastSeg) return
  const segAge = nowMs - ms(lastSeg.start)
  if (segAge < SEGMENT_MERGE_THRESHOLD_MS) {
    if (active.segments.length === 1) {
      next.splice(idx, 1)
    } else {
      active.segments.pop()
      active.status = 'paused'
    }
    return
  }
  active.status = 'paused'
  if (!lastSeg.end) lastSeg.end = iso(nowMs)
}

// 재개 시 직전 구간이 1분 미만 전에 닫혔으면 새 구간을 만들지 않고 그 구간을 다시 연다.
function reopenOrPush(session, nowMs) {
  const lastSeg = session.segments[session.segments.length - 1]
  if (lastSeg && lastSeg.end && (nowMs - ms(lastSeg.end)) < SEGMENT_MERGE_THRESHOLD_MS) {
    lastSeg.end = null
    return
  }
  session.segments.push({ start: iso(nowMs), end: null })
}

// ===== 변이 (mutations) =====
// 반환 형태 통일: { sessions, ok?, error?, unchanged? }
// ok/error가 있는 함수는 실패 시 원본 sessions를 그대로 돌려준다(호출부가 저장 생략).

// 작업 시작/재개. 이미 active면 변화 없음, paused면 재개, 없으면 신규 active.
export function applyStart(sessions, { issueKey, summary }, nowMs) {
  const next = clone(sessions)
  const existing = next.find(s => s.issueKey === issueKey)
  if (existing) {
    if (existing.status === 'paused') {
      pauseActive(next, nowMs)
      existing.status = 'active'
      reopenOrPush(existing, nowMs)
    }
    return { sessions: next }
  }
  // 기존 active 세션 자동 중단 (1분 미만이면 덮어쓰기)
  pauseActive(next, nowMs)
  next.push({
    issueKey,
    summary: summary || '',
    status: 'active',
    segments: [{ start: iso(nowMs), end: null }],
  })
  return { sessions: next }
}

// 명시적 중단 (사용자가 '중단' 클릭). 1분 미만 폐기 규칙은 적용하지 않는다.
export function applyPause(sessions, { issueKey }, nowMs) {
  const next = clone(sessions)
  const s = next.find(x => x.issueKey === issueKey)
  if (s && s.status === 'active') {
    s.status = 'paused'
    const lastSeg = s.segments[s.segments.length - 1]
    if (lastSeg && !lastSeg.end) lastSeg.end = iso(nowMs)
  }
  return { sessions: next }
}

// 재개. 기존 active 세션은 1분 폐기 규칙으로 자동 중단.
export function applyResume(sessions, { issueKey }, nowMs) {
  const next = clone(sessions)
  const s = next.find(x => x.issueKey === issueKey)
  if (s && s.status === 'paused') {
    pauseActive(next, nowMs)
    s.status = 'active'
    reopenOrPush(s, nowMs)
  }
  return { sessions: next }
}

// 세션 제거 (취소/종료 완료).
export function applyRemove(sessions, { issueKey }) {
  return { sessions: clone(sessions).filter(s => s.issueKey !== issueKey) }
}

// 세션의 특정 구간 삭제. 마지막 남은 1구간은 삭제 불가.
// active 세션에서 열린 구간을 삭제한 경우 paused로 전환.
export function applyDeleteSegment(sessions, { issueKey, segIdx }) {
  const next = clone(sessions)
  const s = next.find(x => x.issueKey === issueKey)
  if (!s) return { sessions, ok: false, error: '세션을 찾을 수 없습니다.' }
  if (s.segments.length <= 1) return { sessions, ok: false, error: '마지막 구간은 삭제할 수 없습니다.' }
  if (segIdx < 0 || segIdx >= s.segments.length) return { sessions, ok: false, error: '잘못된 구간입니다.' }
  s.segments.splice(segIdx, 1)
  if (s.status === 'active' && !s.segments.some(seg => !seg.end)) {
    s.status = 'paused'
  }
  return { sessions: next, ok: true }
}

// 세션의 이슈 키/요약 교체. segments/status는 유지.
// 대상 키 세션이 이미 존재하면 실패 (병합 미지원).
export function applySwap(sessions, { oldKey, newKey, newSummary }) {
  if (!oldKey || !newKey) return { sessions, ok: false, error: '잘못된 요청입니다.' }
  if (oldKey === newKey) return { sessions, ok: true, unchanged: true }
  const next = clone(sessions)
  const target = next.find(s => s.issueKey === oldKey)
  if (!target) return { sessions, ok: false, error: '세션을 찾을 수 없습니다.' }
  if (next.some(s => s.issueKey === newKey)) {
    return { sessions, ok: false, error: '이미 해당 이슈로 진행 중/중단된 세션이 있어요.' }
  }
  target.issueKey = newKey
  target.summary = newSummary || ''
  return { sessions: next, ok: true }
}

// 세션 첫 구간의 시작 시각 변경 (직전 종료 시간으로 조정 등).
// 검증(더 늦은 시간으로 못 미룸 등)은 호출부 UI가 담당.
export function applyAdjustStart(sessions, { issueKey, newStartMs }) {
  const next = clone(sessions)
  const s = next.find(x => x.issueKey === issueKey)
  if (!s || !s.segments.length) return { sessions, ok: false, error: '세션을 찾을 수 없습니다.' }
  s.segments[0].start = iso(newStartMs)
  return { sessions: next, ok: true }
}

// ===== 조회 헬퍼 (ms 기반 — 서버/위젯용) =====

// 세션 첫 시작 시각(ms). 구간이 없으면 null.
export function getStartedMs(session) {
  return session.segments.length ? ms(session.segments[0].start) : null
}

// 세션 총 활성 시간(분). 열린 구간은 nowMs까지로 계산.
export function getElapsedMinutes(session, nowMs) {
  let totalMs = 0
  for (const seg of session.segments) {
    const end = seg.end ? ms(seg.end) : nowMs
    totalMs += end - ms(seg.start)
  }
  return Math.floor(totalMs / 60000)
}

// ===== 액션 디스패처 (서버리스 POST 라우팅용) =====
// action 문자열 → 해당 apply* 호출. 알 수 없는 action은 ok:false.
// 변이 진입 전 공통 입력 검증 — undefined/비문자열 issueKey 세션 생성,
// Infinity 타임스탬프(iso()의 toISOString RangeError → 500) 등을 차단한다.
const KEYED_ACTIONS = new Set(['start', 'pause', 'resume', 'remove', 'deleteSegment', 'adjustStart'])
const isValidKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= 100

export function applyAction(action, sessions, payload = {}, nowMs = Date.now()) {
  if (!payload || typeof payload !== 'object') {
    return { sessions, ok: false, error: '잘못된 payload입니다.' }
  }
  if (KEYED_ACTIONS.has(action) && !isValidKey(payload.issueKey)) {
    return { sessions, ok: false, error: 'issueKey가 올바르지 않습니다.' }
  }
  if (action === 'swap' && (!isValidKey(payload.oldKey) || !isValidKey(payload.newKey))) {
    return { sessions, ok: false, error: '잘못된 요청입니다.' }
  }
  if (action === 'adjustStart' && !Number.isFinite(payload.newStartMs)) {
    return { sessions, ok: false, error: 'newStartMs가 올바르지 않습니다.' }
  }
  if (action === 'deleteSegment' && !Number.isInteger(payload.segIdx)) {
    return { sessions, ok: false, error: 'segIdx가 올바르지 않습니다.' }
  }
  switch (action) {
    case 'start':        return { ...applyStart(sessions, payload, nowMs), ok: true }
    case 'pause':        return { ...applyPause(sessions, payload, nowMs), ok: true }
    case 'resume':       return { ...applyResume(sessions, payload, nowMs), ok: true }
    case 'remove':       return { ...applyRemove(sessions, payload), ok: true }
    case 'deleteSegment':return applyDeleteSegment(sessions, payload)
    case 'swap':         return applySwap(sessions, payload)
    case 'adjustStart':  return applyAdjustStart(sessions, payload)
    // replaceAll(마이그레이션 시드): issueKey가 유효한 항목만 수용해 임의 구조 저장 방지
    case 'replaceAll':   return { sessions: clone((Array.isArray(payload.sessions) ? payload.sessions : []).filter(s => s && isValidKey(s.issueKey))), ok: true }
    default:             return { sessions, ok: false, error: `알 수 없는 action: ${action}` }
  }
}
