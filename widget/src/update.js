// 자동 업데이트 확인/설치 — 위젯 본체(시작 시 1회)와 설정 창(버튼)이 공유한다.
import { check as checkUpdate } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { escapeHtml } from './shared.js'

// 버튼 UI를 물려 업데이트를 확인한다(확인 중 → 최신/실패 시 3초 후 원복).
export async function runUpdateCheck(btn) {
  btn.disabled = true
  btn.classList.remove('is-latest', 'is-error')
  btn.textContent = '업데이트 확인 중…'
  try {
    const update = await checkUpdate()
    if (update) {
      // 업데이트 있음 → 버튼 원복 후 설치 모달
      btn.textContent = '업데이트 확인'
      btn.disabled = false
      showUpdateModal(update)
    } else {
      // 최신 → 초록 버튼 + 메시지, 3초 후 원래대로 fade 회귀
      btn.textContent = '최신 버전입니다!'
      btn.classList.add('is-latest')
      setTimeout(() => {
        btn.classList.remove('is-latest')
        btn.textContent = '업데이트 확인'
        btn.disabled = false
      }, 3000)
    }
  } catch (e) {
    console.error('업데이트 확인 실패:', e)
    btn.textContent = '확인 실패'
    btn.classList.add('is-error')
    setTimeout(() => {
      btn.classList.remove('is-error')
      btn.textContent = '업데이트 확인'
      btn.disabled = false
    }, 3000)
  }
}

// 시작 시 1회 자동 업데이트 확인 — 있으면 설치 모달, 없거나 실패면 조용히 무시(버튼 UI 없음).
let autoUpdateChecked = false
export async function autoCheckUpdateOnce() {
  if (autoUpdateChecked) return   // boot 재호출(재시도 등)에도 1회만
  autoUpdateChecked = true
  try {
    const update = await checkUpdate()
    if (update) showUpdateModal(update)
  } catch (e) {
    console.error('시작 시 자동 업데이트 확인 실패:', e)
  }
}

// 업데이트 설치 확인 모달(호출한 창 위 오버레이)
export function showUpdateModal(update) {
  const overlay = document.createElement('div')
  overlay.className = 'update-overlay'
  overlay.innerHTML = `
    <div class="update-modal">
      <div class="update-title">업데이트가 있습니다</div>
      <div class="update-ver">v${escapeHtml(update.version)}${update.currentVersion ? ` <span class="dim">(현재 v${escapeHtml(update.currentVersion)})</span>` : ''}</div>
      <div class="update-progress dim" id="update-progress"></div>
      <div class="update-actions">
        <button class="btn-sm" id="update-later">나중에</button>
        <button class="btn-sm btn-primary" id="update-now">설치</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  overlay.querySelector('#update-later').onclick = () => overlay.remove()
  overlay.querySelector('#update-now').onclick = async () => {
    const now = overlay.querySelector('#update-now')
    const later = overlay.querySelector('#update-later')
    const prog = overlay.querySelector('#update-progress')
    now.disabled = true; later.disabled = true; now.textContent = '설치 중…'
    try {
      let downloaded = 0, total = 0
      await update.downloadAndInstall((e) => {
        if (e.event === 'Started') { total = (e.data && e.data.contentLength) || 0; prog.textContent = '다운로드 중…' }
        else if (e.event === 'Progress') { downloaded += (e.data && e.data.chunkLength) || 0; prog.textContent = total ? `다운로드 ${Math.round(downloaded / total * 100)}%` : '다운로드 중…' }
        else if (e.event === 'Finished') { prog.textContent = '설치 후 재시작합니다…' }
      })
      await relaunch()
    } catch (err) {
      console.error('업데이트 설치 실패:', err)
      prog.textContent = '설치 실패'
      now.disabled = false; later.disabled = false; now.textContent = '설치'
    }
  }
}
