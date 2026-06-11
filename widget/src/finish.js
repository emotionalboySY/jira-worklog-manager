// 작업 종료 다이얼로그(별도 작은 창). ?key=<issueKey> 로 대상 세션을 받는다.
// 세션 조회 → 기록할 시간(점심 제외) 미리보기 + 코멘트 입력 → Jira 워크로그 생성 → 세션 제거 →
// 'sessions-changed' 이벤트로 위젯 본체 갱신 트리거 → 창 닫기.
//
// 제출은 비원자적(worklog 생성 N건 + 세션 제거)이라 진행 상황을 추적한다:
// - 첫 제출 시 조각 목록/코멘트를 고정(frozen) — 재시도 때 재계산하면 다른 조각이 만들어짐
// - postedCount: 기록 완료된 조각 수 — 재시도 시 이어서 기록 (중복 worklog 방지)
// - worklogsDone: 기록은 전부 끝났고 세션 제거만 실패한 상태 — 재시도는 제거만 다시 실행
import { getCurrentWindow } from '@tauri-apps/api/window'
import { emit } from '@tauri-apps/api/event'
import { getSessions, postSessionAction, postWorklogPieces, sessionWorklogs } from './api.js'

const win = getCurrentWindow()
const key = new URLSearchParams(location.search).get('key')
const NO_ISSUE_KEY = '__NO_ISSUE__'

let session = null
let busy = false
let frozenPieces = null   // 첫 제출 시점의 worklog 조각 (재시도 간 불변)
let frozenComment = ''    // 첫 제출 시점의 코멘트 (조각 간 코멘트 불일치 방지)
let postedCount = 0       // 기록 완료된 조각 수
let worklogsDone = false  // 모든 조각 기록 완료 (세션 제거만 남음)

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
  ok.textContent = worklogsDone ? '세션 정리 중…' : '기록 중…'
  errEl.textContent = ''
  try {
    if (!worklogsDone) {
      // 첫 제출에서 조각/코멘트 고정 — 재시도 시 활성 구간의 '지금'이 달라져
      // 다른 조각이 계산되는 것을 방지
      if (!frozenPieces) {
        frozenPieces = sessionWorklogs(session)
        frozenComment = document.getElementById('cmt')?.value || ''
        if (!frozenPieces.length) throw new Error('기록할 시간이 없습니다(점심 제외 후 0분).')
      }
      postedCount = await postWorklogPieces(session.issueKey, frozenPieces, frozenComment, { from: postedCount })
      worklogsDone = true
    }
    await postSessionAction('remove', { issueKey: session.issueKey })
    await emit('sessions-changed')
    await win.close()
  } catch (e) {
    if (typeof e?.posted === 'number') postedCount = e.posted
    if (!worklogsDone && postedCount === 0) {
      // 아직 아무것도 기록되지 않음 — 고정 해제해 다음 시도에서 시간/코멘트를 새로 계산
      frozenPieces = null
      frozenComment = ''
    } else {
      // 일부라도 기록됨 — 남은 조각과 코멘트가 고정됐으므로 코멘트 수정 잠금
      const cmt = document.getElementById('cmt')
      if (cmt) cmt.disabled = true
    }
    if (worklogsDone) {
      // worklog는 전부 기록됨 — 세션 제거만 실패. 재시도는 제거만 다시 실행한다.
      errEl.textContent = `워크로그 ${postedCount}건 기록은 완료됐습니다. 세션 정리에 실패했습니다(${e.message || '오류'}) — 다시 시도하면 세션 정리만 다시 실행합니다.`
      ok.textContent = '세션 정리 재시도'
    } else if (postedCount > 0) {
      errEl.textContent = `${frozenPieces.length}건 중 ${postedCount}건 기록 후 실패: ${e.message || '오류'} — 다시 시도하면 남은 ${frozenPieces.length - postedCount}건부터 이어서 기록합니다. (취소하면 이미 기록된 ${postedCount}건은 Jira에 남습니다)`
      ok.textContent = '이어서 기록'
    } else {
      errEl.textContent = e.message || '기록에 실패했습니다.'
      ok.textContent = 'Jira에 기록'
    }
    ok.disabled = false
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
