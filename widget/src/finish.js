// 작업 종료 다이얼로그(별도 작은 창). ?key=<issueKey> 로 대상 세션을 받는다.
// 세션 조회 → 기록할 시간(점심 제외) 미리보기 + 코멘트 입력 → Jira 워크로그 생성 → 세션 제거 →
// 'sessions-changed' 이벤트로 위젯 본체 갱신 트리거 → 창 닫기.
import { getCurrentWindow } from '@tauri-apps/api/window'
import { emit } from '@tauri-apps/api/event'
import { getSessions, postSessionAction, finishSession, sessionWorklogs } from './api.js'

const win = getCurrentWindow()
const key = new URLSearchParams(location.search).get('key')
const NO_ISSUE_KEY = '__NO_ISSUE__'

let session = null
let busy = false

function fmtMinutes(min) {
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m}분`
  if (m === 0) return `${h}시간`
  return `${h}시간 ${m}분`
}
function previewMinutes(s) {
  return Math.round(sessionWorklogs(s).reduce((a, p) => a + p.seconds, 0) / 60)
}
function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const app = () => document.getElementById('finish-app')

function renderMessage(msg, isError) {
  app().innerHTML = `
    <div class="dlg">
      <p class="${isError ? 'err' : 'dim'}">${esc(msg)}</p>
      <div class="dlg-actions"><button id="dlg-close">닫기</button></div>
    </div>`
  document.getElementById('dlg-close').onclick = () => win.close()
}

function renderForm() {
  const mins = previewMinutes(session)
  app().innerHTML = `
    <div class="dlg">
      <div class="dlg-title">작업 종료 — <b>${esc(key)}</b></div>
      <div class="dlg-sub">${esc(session.summary)}</div>
      <div class="dlg-time">기록할 시간 <b>${fmtMinutes(mins)}</b> <span class="dim">· 점심 제외</span></div>
      <textarea id="cmt" rows="3" placeholder="코멘트(선택)"></textarea>
      <div class="dlg-actions">
        <button id="dlg-cancel">취소</button>
        <button id="dlg-ok" class="primary">Jira에 기록</button>
      </div>
      <div id="dlg-err" class="err"></div>
    </div>`
  document.getElementById('dlg-cancel').onclick = () => win.close()
  document.getElementById('dlg-ok').onclick = submit
  document.getElementById('cmt').focus()
}

async function submit() {
  if (busy) return
  busy = true
  const ok = document.getElementById('dlg-ok')
  const errEl = document.getElementById('dlg-err')
  ok.disabled = true
  ok.textContent = '기록 중…'
  errEl.textContent = ''
  const comment = document.getElementById('cmt').value || ''
  try {
    const n = await finishSession(session, comment)
    await postSessionAction('remove', { issueKey: session.issueKey })
    await emit('sessions-changed')
    await win.close()
  } catch (e) {
    errEl.textContent = e.message || '기록에 실패했습니다.'
    ok.disabled = false
    ok.textContent = 'Jira에 기록'
    busy = false
  }
}

async function boot() {
  if (!key) { renderMessage('대상 세션이 없습니다.', true); return }
  if (key === NO_ISSUE_KEY) { renderMessage('일감 미지정 세션은 웹앱에서 종료해주세요.', true); return }
  renderMessage('불러오는 중…', false)
  try {
    const data = await getSessions()
    session = (data.sessions || []).find(s => s.issueKey === key)
    if (!session) { renderMessage('세션을 찾을 수 없습니다. (이미 종료됐을 수 있어요)', true); return }
    renderForm()
  } catch (e) {
    renderMessage(e.message || '세션을 불러오지 못했습니다.', true)
  }
}

// Ctrl+Enter(또는 Cmd+Enter)로 제출 — 폼이 떠 있고 처리 중이 아닐 때만
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && session && !busy) {
    e.preventDefault()
    submit()
  }
})

boot()
