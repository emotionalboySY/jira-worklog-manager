// 대한민국 법정 공휴일 데이터 (2025~2027)
// 대체공휴일 규칙(2023~):
// - 설날·추석 연휴, 어린이날: 토·일 모두 적용
// - 그 외(3.1, 광복절, 개천절, 한글날, 부처님오신날, 성탄절): 일요일만 적용
// - 신정·현충일: 대체공휴일 미적용
// 매년 12월쯤 다음 해 데이터를 추가해야 함.
// 사용자가 공휴일 설정 모달에서 추가/수정/삭제한 내용은 localStorage 오버라이드로
// 이 기본 목록 위에 병합된다 (아래 '사용자 오버라이드' 섹션).
const HOLIDAYS = {
  // 2025년
  '2025-01-01': '신정',
  '2025-01-27': '임시공휴일',
  '2025-01-28': '설날 연휴',
  '2025-01-29': '설날',
  '2025-01-30': '설날 연휴',
  '2025-03-01': '삼일절',
  '2025-03-03': '대체공휴일(삼일절)',
  '2025-05-05': '어린이날·부처님오신날',
  '2025-05-06': '대체공휴일(어린이날)',
  '2025-06-03': '대통령 선거',
  '2025-06-06': '현충일',
  '2025-08-15': '광복절',
  '2025-10-03': '개천절',
  '2025-10-05': '추석 연휴',
  '2025-10-06': '추석',
  '2025-10-07': '추석 연휴',
  '2025-10-08': '대체공휴일(추석)',
  '2025-10-09': '한글날',
  '2025-12-25': '성탄절',

  // 2026년
  '2026-01-01': '신정',
  '2026-02-16': '설날 연휴',
  '2026-02-17': '설날',
  '2026-02-18': '설날 연휴',
  '2026-03-01': '삼일절',
  '2026-03-02': '대체공휴일(삼일절)',
  '2026-05-01': '근로자의 날',
  '2026-05-05': '어린이날',
  '2026-05-24': '부처님오신날',
  '2026-05-25': '대체공휴일(부처님오신날)',
  '2026-06-06': '현충일',
  '2026-08-15': '광복절',
  '2026-09-24': '추석 연휴',
  '2026-09-25': '추석',
  '2026-09-26': '추석 연휴',
  '2026-09-28': '대체공휴일(추석)',
  '2026-10-03': '개천절',
  '2026-10-09': '한글날',
  '2026-12-25': '성탄절',

  // 2027년
  '2027-01-01': '신정',
  '2027-02-06': '설날 연휴',
  '2027-02-07': '설날',
  '2027-02-08': '설날 연휴',
  '2027-02-09': '대체공휴일(설날)',
  '2027-03-01': '삼일절',
  '2027-05-01': '근로자의 날',
  '2027-05-05': '어린이날',
  '2027-05-13': '부처님오신날',
  '2027-06-06': '현충일',
  '2027-08-15': '광복절',
  '2027-08-16': '대체공휴일(광복절)',
  '2027-09-14': '추석 연휴',
  '2027-09-15': '추석',
  '2027-09-16': '추석 연휴',
  '2027-10-03': '개천절',
  '2027-10-04': '대체공휴일(개천절)',
  '2027-10-09': '한글날',
  '2027-12-25': '성탄절',
}

// ========== 사용자 오버라이드 (공휴일 설정 모달) ==========
// localStorage에 기본 목록과의 "차이"만 저장한다:
//   { 'YYYY-MM-DD': '이름' }  → 추가 또는 이름 변경
//   { 'YYYY-MM-DD': null }    → 기본 공휴일 삭제
const HOLIDAY_OVERRIDES_KEY = 'holiday_overrides'

let _overrides = null // localStorage 파싱 캐시
let _merged = null    // 기본 + 오버라이드 병합 캐시

function loadOverrides() {
  if (_overrides) return _overrides
  try {
    const raw = localStorage.getItem(HOLIDAY_OVERRIDES_KEY)
    const obj = raw ? JSON.parse(raw) : {}
    _overrides = obj && typeof obj === 'object' ? obj : {}
  } catch { _overrides = {} }
  return _overrides
}

function mergedHolidays() {
  if (_merged) return _merged
  const m = { ...HOLIDAYS }
  for (const [date, name] of Object.entries(loadOverrides())) {
    if (name === null || name === '') delete m[date]
    else m[date] = name
  }
  _merged = m
  return m
}

// 편집 UI용: 오버라이드가 반영된 전체 공휴일 맵 { 'YYYY-MM-DD': 이름 }
export function getEffectiveHolidays() {
  return { ...mergedHolidays() }
}

// 편집 UI의 재설정용: 기본 제공 목록
export function getBaseHolidays() {
  return { ...HOLIDAYS }
}

// 편집 결과([{ date, name }])를 기본 목록과 diff해 오버라이드로 저장.
// 이름이 빈 항목은 무시(= 해당 날짜 공휴일 없음으로 처리).
export function saveHolidaysFromList(list) {
  const effective = {}
  for (const { date, name } of list) {
    const n = (name || '').trim()
    if (date && n) effective[date] = n
  }
  const overrides = {}
  for (const [date, name] of Object.entries(effective)) {
    if (HOLIDAYS[date] !== name) overrides[date] = name
  }
  for (const date of Object.keys(HOLIDAYS)) {
    if (!(date in effective)) overrides[date] = null
  }
  try { localStorage.setItem(HOLIDAY_OVERRIDES_KEY, JSON.stringify(overrides)) } catch {}
  _overrides = null
  _merged = null
}

// 'YYYY-MM-DD' → 공휴일 이름 또는 null
export function getHoliday(dateStr) {
  return mergedHolidays()[dateStr] || null
}

export function isHoliday(dateStr) {
  return !!mergedHolidays()[dateStr]
}
