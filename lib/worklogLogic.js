// 워크로그 변환 공통 로직 — 웹앱(src/)과 데스크톱 위젯(widget/src/)이 함께 import한다.
// sessionLogic.js와 같은 패턴의 의존성 없는 공유 모듈.
//
// 핵심 규칙 (단일 소스):
// - 점심시간(기본 11:30~12:30)과 겹치는 구간은 점심 앞/뒤 2개의 worklog로 분할
// - 자정을 넘긴 구간은 날짜 경계(로컬 자정)로 먼저 분할한 뒤 날짜별로 점심 분할 적용
//   (기존에는 분-of-day만 비교해 자정 넘김 구간이 조용히 누락되거나 차단됐음)
// - worklog는 분 해상도로 기록 (초는 내림)
//
// 점심시간은 더 이상 고정 상수가 아니라 함수 인자(lunch)로 주입한다.
// - lunch = { start, end } (분 단위, 0~1440). 미지정 시 기본값(DEFAULT_LUNCH) 사용 → 위젯 등 기존 호출부 무수정 호환.
// - 차감하지 않으려면(점심 안 먹은 날 등) start >= end 인 값을 넘기면 분할/차감이 일어나지 않는다.

export const LUNCH_START = 11 * 60 + 30 // 11:30 (분 단위) — 기본 점심 시작
export const LUNCH_END = 12 * 60 + 30   // 12:30 (분 단위) — 기본 점심 종료
export const DEFAULT_LUNCH = { start: LUNCH_START, end: LUNCH_END }

// 종료 시간이 시작 시간보다 이를 때, 별도 확인 없이 '자정 넘김'으로 자동 인정하는 최대 구간(분).
// 22:00~01:00(3시간)처럼 짧은 야간 작업은 자동 인정하고,
// 13:00~09:00(20시간)처럼 오입력이 분명한 구간은 호출부가 '다음 날'을 명시(nextDay=true)해야 기록된다.
export const OVERNIGHT_AUTO_LIMIT_MINUTES = 6 * 60

// lunch 인자를 안전한 { start, end }로 정규화. 무효(빈 값/역전)면 null → 차감 없음으로 처리.
function normalizeLunch(lunch) {
  if (!lunch) return null
  const start = Number(lunch.start)
  const end = Number(lunch.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return { start, end }
}

// Jira worklog API의 started 필드용 타임존 문자열 (+0900 형식, 콜론 없음)
export function getJiraTzOffset() {
  const offset = new Date().getTimezoneOffset()
  const sign = offset <= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`
}

function ymd(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function minToHHmm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

function jiraStarted(dateStr, min) {
  return `${dateStr}T${minToHHmm(min)}:00.000${getJiraTzOffset()}`
}

// "YYYY-MM-DD" + "HH:mm"(또는 "HH:mm:ss") → 로컬 Date (초 이하 버림)
function dateAtTime(dateStr, timeStr) {
  const [h = '0', m = '0'] = String(timeStr).split(':')
  const d = new Date(`${dateStr}T00:00:00`)
  d.setHours(Number(h), Number(m), 0, 0)
  return d
}

// 하루 안(분 단위, 0~1440)의 [start,end) 구간을 점심시간을 피해 분할 → [[s,e], ...]
// 종료 시각을 유지하기 위해 점심 앞/뒤로 쪼갠다.
export function splitDayRangeAroundLunch(startMin, endMin, lunch = DEFAULT_LUNCH) {
  const L = normalizeLunch(lunch)
  const ranges = []
  if (!L || endMin <= L.start || startMin >= L.end) {
    ranges.push([startMin, endMin])
  } else {
    if (startMin < L.start) ranges.push([startMin, L.start])
    if (endMin > L.end) ranges.push([L.end, endMin])
  }
  return ranges.filter(([s, e]) => e > s)
}

// 절대 시각 구간(Date ~ Date)을 로컬 자정 경계로 분할 → [{ dateStr, startMin, endMin }]
// endMin은 자정 도달 시 1440. 초 단위는 분으로 내림.
export function splitRangeByLocalDay(startDate, endDate) {
  const out = []
  let cur = new Date(startDate)
  cur.setSeconds(0, 0)
  const end = new Date(endDate)
  end.setSeconds(0, 0)
  let guard = 0 // 비정상 입력(수년짜리 구간 등)으로 인한 폭주 방지
  while (cur < end && guard++ < 62) {
    const nextMidnight = new Date(cur)
    nextMidnight.setHours(24, 0, 0, 0)
    const pieceEnd = end < nextMidnight ? end : nextMidnight
    const startMin = cur.getHours() * 60 + cur.getMinutes()
    const endMin = pieceEnd.getTime() === nextMidnight.getTime()
      ? 1440
      : pieceEnd.getHours() * 60 + pieceEnd.getMinutes()
    out.push({ dateStr: ymd(cur), startMin, endMin })
    cur = nextMidnight
  }
  return out
}

// 절대 시각 구간 → 자정 분할 + 점심 분할 → [{ started, seconds }, ...]
export function buildWorklogPiecesFromRange(startDate, endDate, lunch = DEFAULT_LUNCH) {
  const pieces = []
  for (const day of splitRangeByLocalDay(startDate, endDate)) {
    for (const [s, e] of splitDayRangeAroundLunch(day.startMin, day.endMin, lunch)) {
      pieces.push({ started: jiraStarted(day.dateStr, s), seconds: (e - s) * 60 })
    }
  }
  return pieces
}

// "HH:mm"(또는 "HH:mm:ss") → 분 단위 정수. 무효면 null.
function parseTimeMinutes(str) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(str || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
  return h * 60 + mi
}

// 시작/종료 "HH:mm" 구간 판정 — 자정 넘김 여부를 여기서 단일하게 결정한다.
// nextDay: true  = 사용자가 '다음 날'을 명시 → 무조건 다음 날 종료
//          false = 사용자가 '다음 날'을 해제 → 같은 날로만 해석(종료<시작이면 무효)
//          null/undefined = 자동 판정 (넘긴 구간이 OVERNIGHT_AUTO_LIMIT_MINUTES 이내일 때만 인정)
// 반환:
//   valid            기록 가능한 구간인지
//   reason           무효 사유 'empty'(입력 없음) | 'zero'(시작==종료) | 'reversed'(종료<시작인데 다음 날 아님)
//   crossesMidnight  다음 날로 이어지는 구간인지
//   spanMinutes      점심 차감 전 구간 길이(분)
//   overnightEligible 종료<시작이어서 '다음 날' 토글을 보여줘야 하는 상태인지
//   autoOvernight    임계값 이내라 자동으로 자정 넘김을 인정한 경우인지
export function resolveTimeRange(startTime, endTime, nextDay = null) {
  const base = { valid: false, crossesMidnight: false, spanMinutes: 0, overnightEligible: false, autoOvernight: false }
  const s = parseTimeMinutes(startTime)
  const e = parseTimeMinutes(endTime)
  if (s == null || e == null) return { ...base, reason: 'empty' }
  if (e > s) return { ...base, valid: true, spanMinutes: e - s }
  // 동일 시각은 0분 — 24시간 worklog로 오인하지 않도록 자정 넘김으로 보지 않는다.
  if (e === s) return { ...base, reason: 'zero' }
  const span = 1440 - s + e
  const autoOvernight = span <= OVERNIGHT_AUTO_LIMIT_MINUTES
  const useNextDay = nextDay === true || (nextDay == null && autoOvernight)
  return {
    valid: useNextDay,
    reason: useNextDay ? undefined : 'reversed',
    crossesMidnight: useNextDay,
    spanMinutes: span,
    overnightEligible: true,
    autoOvernight,
  }
}

// "HH:mm" 기반 — resolveTimeRange 판정에 따라 다음 날 종료로 이어붙인다.
// 무효 구간(종료<시작인데 '다음 날'이 아님 / 시작==종료)이면 빈 배열.
export function buildWorklogPiecesFromTimes(dateStr, startTime, endTime, lunch = DEFAULT_LUNCH, nextDay = null) {
  const r = resolveTimeRange(startTime, endTime, nextDay)
  if (!r.valid) return []
  const start = dateAtTime(dateStr, startTime)
  const end = dateAtTime(dateStr, endTime)
  if (r.crossesMidnight) end.setDate(end.getDate() + 1)
  return buildWorklogPiecesFromRange(start, end, lunch)
}

// 절대 시각 구간의 총/점심/실작업 분 계산 (자정 넘김 포함 — 날짜별 점심 겹침 합산)
export function computeRangeMinutes(startDate, endDate, lunch = DEFAULT_LUNCH) {
  const L = normalizeLunch(lunch)
  let totalMinutes = 0
  let lunchMinutes = 0
  for (const day of splitRangeByLocalDay(startDate, endDate)) {
    totalMinutes += day.endMin - day.startMin
    if (L) lunchMinutes += Math.max(0, Math.min(day.endMin, L.end) - Math.max(day.startMin, L.start))
  }
  return { totalMinutes, lunchMinutes, actualMinutes: Math.max(0, totalMinutes - lunchMinutes) }
}

// "HH:mm" 기반 duration 계산. 자정 넘김 판정은 resolveTimeRange에 위임한다.
// 무효 구간이면 0분 + reason을 함께 돌려줘 호출부가 안내 문구를 고를 수 있게 한다.
// 날짜는 분 계산에만 쓰이므로 임의 기준일을 사용한다.
export function computeMinutesFromTimes(startTime, endTime, lunch = DEFAULT_LUNCH, nextDay = null) {
  const r = resolveTimeRange(startTime, endTime, nextDay)
  if (!r.valid) return { totalMinutes: 0, lunchMinutes: 0, actualMinutes: 0, ...r }
  const ref = '2000-01-06' // 임의 기준일 (요일/공휴일 무관)
  const start = dateAtTime(ref, startTime)
  const end = dateAtTime(ref, endTime)
  if (r.crossesMidnight) end.setDate(end.getDate() + 1)
  return { ...computeRangeMinutes(start, end, lunch), ...r }
}
