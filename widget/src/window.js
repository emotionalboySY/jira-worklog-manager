// 위젯 본체 창의 데스크톱 동작: 화면 가장자리 마그넷 스냅 + 비율 고정 리사이즈.
// main 윈도우에서만 사용한다(종료 다이얼로그는 고정 크기라 제외).
import { getCurrentWindow, currentMonitor, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window'

const SNAP = 24            // 가장자리 흡착 임계값(물리 px)
const RATIO = 300 / 150    // 기준 종횡비(가로/세로) — tauri.conf.json 기본 창 크기와 일치

export async function initWindowBehaviors() {
  const win = getCurrentWindow()

  // ===== 마그넷 스냅: 드래그 중 모니터 가장자리 근처에 오면 흡착 =====
  // setPosition으로 인한 onMoved 재진입은 직전 설정값과 비교해 무시한다.
  let lastMove = null
  await win.onMoved(async ({ payload }) => {
    if (lastMove && lastMove.x === payload.x && lastMove.y === payload.y) { lastMove = null; return }
    const mon = await currentMonitor()
    if (!mon) return
    const size = await win.outerSize()
    const { x: mx, y: my } = mon.position
    const { width: mw, height: mh } = mon.size
    let x = payload.x
    let y = payload.y
    // 좌/우 가장자리
    if (Math.abs(x - mx) <= SNAP) x = mx
    else if (Math.abs((x + size.width) - (mx + mw)) <= SNAP) x = mx + mw - size.width
    // 상/하 가장자리
    if (Math.abs(y - my) <= SNAP) y = my
    else if (Math.abs((y + size.height) - (my + mh)) <= SNAP) y = my + mh - size.height
    if (x !== payload.x || y !== payload.y) {
      lastMove = { x, y }
      await win.setPosition(new PhysicalPosition(x, y))
    }
  })

  // ===== 비율 고정 리사이즈: 더 많이 변한 축을 기준으로 반대 축을 RATIO에 맞춤 =====
  let prev = await win.outerSize()
  let lastSize = null
  await win.onResized(async ({ payload }) => {
    if (lastSize && lastSize.width === payload.width && lastSize.height === payload.height) {
      lastSize = null; prev = payload; return
    }
    const dw = Math.abs(payload.width - prev.width)
    const dh = Math.abs(payload.height - prev.height)
    let w, h
    if (dw >= dh) { w = payload.width; h = Math.round(w / RATIO) }
    else { h = payload.height; w = Math.round(h * RATIO) }
    if (w !== payload.width || h !== payload.height) {
      lastSize = { width: w, height: h }
      prev = { width: w, height: h }
      await win.setSize(new PhysicalSize(w, h))
    } else {
      prev = { width: w, height: h }
    }
  })
}
