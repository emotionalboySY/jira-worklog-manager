// 워크로그 변환 공통 로직 — 웹앱(src/)과 데스크톱 위젯(widget/src/)이 함께 import한다.
// sessionLogic.js와 같은 패턴의 의존성 없는 공유 모듈.
//
// 핵심 규칙 (단일 소스):
// - 점심시간(11:30~12:30)과 겹치는 구간은 점심 앞/뒤 2개의 worklog로 분할
// - 자정을 넘긴 구간은 날짜 경계(로컬 자정)로 먼저 분할한 뒤 날짜별로 점심 분할 적용
//   (기존에는 분-of-day만 비교해 자정 넘김 구간이 조용히 누락되거나 차단됐음)
// - worklog는 분 해상도로 기록 (초는 내림)

export const LUNCH_START = 11 * 60 + 30 // 11:30 (분 단위)
export const LUNCH_END = 12 * 60 + 30   // 12:30 (분 단위)

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
export function splitDayRangeAroundLunch(startMin, endMin) {
  const ranges = []
  if (endMin <= LUNCH_START || startMin >= LUNCH_END) {
    ranges.push([startMin, endMin])
  } else {
    if (startMin < LUNCH_START) ranges.push([startMin, LUNCH_START])
    if (endMin > LUNCH_END) ranges.push([LUNCH_END, endMin])
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
export function buildWorklogPiecesFromRange(startDate, endDate) {
  const pieces = []
  for (const day of splitRangeByLocalDay(startDate, endDate)) {
    for (const [s, e] of splitDayRangeAroundLunch(day.startMin, day.endMin)) {
      pieces.push({ started: jiraStarted(day.dateStr, s), seconds: (e - s) * 60 })
    }
  }
  return pieces
}

// "HH:mm" 기반 — endTime이 startTime보다 이르면 자정을 넘긴 것(다음 날 종료)으로 간주.
// (같으면 0분 → 빈 배열. 24시간 worklog로 오인하지 않도록 동일 시각은 넘김으로 안 봄)
export function buildWorklogPiecesFromTimes(dateStr, startTime, endTime) {
  const start = dateAtTime(dateStr, startTime)
  const end = dateAtTime(dateStr, endTime)
  if (end < start) end.setDate(end.getDate() + 1)
  return buildWorklogPiecesFromRange(start, end)
}

// 절대 시각 구간의 총/점심/실작업 분 계산 (자정 넘김 포함 — 날짜별 점심 겹침 합산)
export function computeRangeMinutes(startDate, endDate) {
  let totalMinutes = 0
  let lunchMinutes = 0
  for (const day of splitRangeByLocalDay(startDate, endDate)) {
    totalMinutes += day.endMin - day.startMin
    lunchMinutes += Math.max(0, Math.min(day.endMin, LUNCH_END) - Math.max(day.startMin, LUNCH_START))
  }
  return { totalMinutes, lunchMinutes, actualMinutes: Math.max(0, totalMinutes - lunchMinutes) }
}

// "HH:mm" 기반 duration 계산. end < start면 자정 넘김으로 간주하고 crossesMidnight 표시.
// 날짜는 분 계산에만 쓰이므로 임의 기준일을 사용한다.
export function computeMinutesFromTimes(startTime, endTime) {
  const ref = '2000-01-06' // 임의 기준일 (요일/공휴일 무관)
  const start = dateAtTime(ref, startTime)
  const end = dateAtTime(ref, endTime)
  const crossesMidnight = end < start
  if (crossesMidnight) end.setDate(end.getDate() + 1)
  return { ...computeRangeMinutes(start, end), crossesMidnight }
}
