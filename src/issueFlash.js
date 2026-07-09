// 외부(웹훅/폴링)에서 변경된 이슈 행을 잠깐 은은히 강조하기 위한 공유 상태.
// actions.js가 변경된 이슈 키를 등록(markIssuesFlashing)하고, views/issues.js가
// 렌더 시 강조 여부를 조회(getFlashState)해 클래스와 지연을 붙인다.
//
// 재렌더로 행 DOM이 재생성돼도 애니메이션이 "이어지도록", 경과 시간을 음수
// animation-delay(CSS 변수 --flash-delay)로 넘겨 중간 지점부터 재생되게 한다.
export const FLASH_MS = 2400

const flashing = new Map() // key → startMs

// 변경된 이슈 키들을 강조 시작(현재 시각 기준). 같은 키 재변경 시 타이머 리셋.
export function markIssuesFlashing(keys) {
  if (!Array.isArray(keys)) return
  const now = Date.now()
  for (const k of keys) if (k) flashing.set(k, now)
}

// 렌더 시 호출: 강조 중이면 { delayMs }(경과 ms), 아니면 null. 만료분은 정리한다.
export function getFlashState(key) {
  const start = flashing.get(key)
  if (start == null) return null
  const elapsed = Date.now() - start
  if (elapsed >= FLASH_MS) { flashing.delete(key); return null }
  return { delayMs: elapsed }
}

export function clearIssueFlash() { flashing.clear() }
