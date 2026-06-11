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
