// DK 워크로그 위젯 — 엔트리 (3a: 창/셸 검증용 최소 버전)
// 이후 단계에서 인증/표시/폴링/컨트롤을 채운다.
import { getCurrentWindow } from '@tauri-apps/api/window'

const appWindow = getCurrentWindow()
let alwaysOnTop = true // tauri.conf.json 기본값과 일치

function render() {
  const app = document.getElementById('app')
  app.innerHTML = `
    <div class="widget">
      <div class="widget-header" data-tauri-drag-region>
        <span class="widget-title" data-tauri-drag-region>DK 워크로그</span>
        <div class="widget-win-buttons">
          <button class="win-btn" id="btn-pin" title="항상 위 고정 토글">${alwaysOnTop ? '📌' : '📍'}</button>
          <button class="win-btn" id="btn-hide" title="숨기기">▁</button>
          <button class="win-btn" id="btn-close" title="닫기">✕</button>
        </div>
      </div>
      <div class="widget-body">
        <div class="placeholder">위젯 셸 동작 확인 중…</div>
      </div>
    </div>
  `
  bind()
}

function bind() {
  document.getElementById('btn-pin')?.addEventListener('click', async () => {
    alwaysOnTop = !alwaysOnTop
    try { await appWindow.setAlwaysOnTop(alwaysOnTop) } catch (e) { console.error(e) }
    render()
  })
  document.getElementById('btn-hide')?.addEventListener('click', async () => {
    try { await appWindow.hide() } catch (e) { console.error(e) }
  })
  document.getElementById('btn-close')?.addEventListener('click', async () => {
    try { await appWindow.close() } catch (e) { console.error(e) }
  })
}

render()
