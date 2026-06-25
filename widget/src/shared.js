// 위젯 3개 창(main/finish/swap)이 공유하는 소형 헬퍼 — 파일별 중복 정의 제거.

export const NO_ISSUE_KEY = '__NO_ISSUE__'

// HTML 이스케이프 (속성 값 포함 — 따옴표까지 처리)
export function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// 분 → "N시간 M분"
export function fmtMinutes(min) {
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m}분`
  if (m === 0) return `${h}시간`
  return `${h}시간 ${m}분`
}

// 분(0~1440) → "HH:MM"
export function fmtHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

// "HH:MM"(또는 "HH:MM:SS") → 분 단위 정수. 무효면 null.
// 일부 환경에서 <input type="time">이 초까지 반환하므로 초도 허용(무시).
export function parseHHMM(str) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(str || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
  return h * 60 + mi
}
