// 이벤트 바인딩 공통 헬퍼.
// 같은 element에 같은 이벤트가 중복 등록되지 않도록 element 프로퍼티에 1회 바인드 플래그를 둠.
// element가 새로 생성되면 내부 프로퍼티가 없으므로 다시 바인드된다 (부분 렌더 후에도 새 element에만 추가됨).
export function on(el, event, handler, options) {
  if (!el) return
  const key = `__bound_${event}`
  if (el[key]) return
  el[key] = true
  el.addEventListener(event, handler, options)
}
