// 이벤트 위임(delegation) 인프라.
// document 레벨에 한 번만 리스너를 달고, e.target에서 가장 가까운 매칭 element를 찾아 dispatch.
// render마다 수십 개의 querySelectorAll/addEventListener 호출이 사라진다.
//
// 사용법
//   registerClickAction('start', (e, el) => { ... })           // [data-action="start"]
//   registerClickData('page',    (e, el) => { ... })           // [data-page=...]
//   registerClickSelector('.project-chip', (e, el) => { ... }) // class 기반
//   registerContextMenu('.issue-row[data-issue-key]', (e, el) => { ... })
//   registerInputAction('summary-input', (e, el) => { ... })   // [data-input-action="..."]
//   installGlobalDelegation()  // (init 1회)

const clickActionHandlers = new Map()    // action name (data-action) → handler
const clickDataHandlers = new Map()      // camelCase data key (data.page 등) → handler
const clickSelectorHandlers = []         // [{ selector, handler }] — 가장 자주 쓰는 클릭만 (위 둘이 매칭 안 될 때)
const contextHandlers = []               // [{ selector, handler }]

// 핸들러: (e, element) => any   element는 closest()로 찾은 매칭 element

export function registerClickAction(action, handler) {
  clickActionHandlers.set(action, handler)
}

export function registerClickData(dataKey, handler) {
  clickDataHandlers.set(dataKey, handler)
}

export function registerClickSelector(selector, handler) {
  clickSelectorHandlers.push({ selector, handler })
}

export function registerContextMenu(selector, handler) {
  contextHandlers.push({ selector, handler })
}

let installed = false
export function installGlobalDelegation() {
  if (installed) return
  installed = true
  document.addEventListener('click', dispatchClick)
  document.addEventListener('contextmenu', dispatchContext)
}

function dispatchClick(e) {
  const target = e.target
  if (!target || !target.closest) return

  // 1) data-action 매칭 (가장 가까운 element)
  const actionEl = target.closest('[data-action]')
  if (actionEl) {
    const handler = clickActionHandlers.get(actionEl.dataset.action)
    if (handler) {
      handler(e, actionEl)
      return  // 첫 매칭 후 종료 (부모 핸들러로 전파 X)
    }
  }

  // 2) data-* 키 매칭 (data-page, data-day-off 등)
  //    인접한 element를 우선해야 정확하므로 e.target에서 가장 가까운 것을 키별로 검사
  for (const [key, handler] of clickDataHandlers) {
    const attr = camelToDataAttr(key)
    const el = target.closest(`[data-${attr}]`)
    if (el) {
      handler(e, el)
      return
    }
  }

  // 3) 셀렉터 매칭 (.project-chip 등)
  for (const { selector, handler } of clickSelectorHandlers) {
    const el = target.closest(selector)
    if (el) {
      handler(e, el)
      return
    }
  }
}

function dispatchContext(e) {
  const target = e.target
  if (!target || !target.closest) return
  for (const { selector, handler } of contextHandlers) {
    const el = target.closest(selector)
    if (el) {
      handler(e, el)
      return
    }
  }
}

// dataset.fooBar → data-foo-bar
function camelToDataAttr(camel) {
  return camel.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
}
