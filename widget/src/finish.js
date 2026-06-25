// 작업 종료 다이얼로그(별도 작은 창). ?key=<issueKey> 로 대상 세션을 받는다.
// 세션 조회 → 구간별 시작/종료 시간(편집 가능) + 점심시간(편집/차감 끄기) → 기록할 시간 미리보기
// → 코멘트 입력 → Jira 워크로그 생성 → 세션 제거 → 'sessions-changed' 이벤트로 본체 갱신 → 창 닫기.
//
// 점심/자정 분할 로직은 웹앱과 공유(lib/worklogLogic.js). 점심시간 기본값은 위젯 설정(settings.json).
//
// 제출은 비원자적(worklog 생성 N건 + 세션 제거)이라 진행 상황을 추적한다:
// - 첫 제출 시 편집값 기준으로 조각 목록/코멘트를 고정(frozen) — 재시도 때 재계산하면 다른 조각이 만들어짐
// - postedCount: 기록 완료된 조각 수 — 재시도 시 이어서 기록 (중복 worklog 방지)
// - worklogsDone: 기록은 전부 끝났고 세션 제거만 실패한 상태 — 재시도는 제거만 다시 실행
import { getCurrentWindow } from '@tauri-apps/api/window'
import { emit } from '@tauri-apps/api/event'
import { load } from '@tauri-apps/plugin-store'
import { getSessions, postSessionAction, postWorklogPieces } from './api.js'
import { escapeHtml as esc, fmtMinutes, fmtHHMM, parseHHMM, NO_ISSUE_KEY } from './shared.js'
import { buildWorklogPiecesFromTimes, DEFAULT_LUNCH } from '../../lib/worklogLogic.js'

const win = getCurrentWindow()
const key = new URLSearchParams(location.search).get('key')

let session = null
let busy = false
let frozenPieces = null   // 첫 제출 시점의 worklog 조각 (재시도 간 불변)
let frozenComment = ''    // 첫 제출 시점의 코멘트 (조각 간 코멘트 불일치 방지)
let postedCount = 0       // 기록 완료된 조각 수
let worklogsDone = false  // 모든 조각 기록 완료 (세션 제거만 남음)
let defaultLunch = { ...DEFAULT_LUNCH }  // 위젯 설정의 기본 점심시간

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

const app = () => document.getElementById('finish-app')

// 위젯 설정(settings.json)에서 기본 점심시간을 읽는다. 없으면 lib 기본값(11:30~12:30).
async function loadDefaultLunch() {
  try {
    const s = await load('settings.json', { autoSave: false })
    const ls = await s.get('lunchStart')
    const le = await s.get('lunchEnd')
    if (typeof ls === 'number' && typeof le === 'number') return { start: ls, end: le }
  } catch (e) { console.error('기본 점심시간 로드 실패:', e) }
  return { ...DEFAULT_LUNCH }
}

// 세션 구간 → 편집용 행 { dateStr, start, end }. 활성(열린) 구간의 종료는 '지금'으로 채운다.
function segInitial(s) {
  return (s.segments || []).map(seg => {
    const start = new Date(seg.start)
    const end = seg.end ? new Date(seg.end) : new Date()
    return { dateStr: ymd(start), start: hhmm(start), end: hhmm(end) }
  })
}

// 현재 DOM의 구간 입력값 읽기
function readRows() {
  return [...document.querySelectorAll('.fseg')].map(row => ({
    dateStr: row.dataset.date,
    start: row.querySelector('.fseg-start')?.value || '',
    end: row.querySelector('.fseg-end')?.value || '',
  }))
}

// 점심시간 입력 읽기 → { start, end }(분). '차감 안 함' 또는 무효/역전이면 차감 없음({0,0}).
function readLunch() {
  if (document.getElementById('lunch-skip')?.checked) return { start: 0, end: 0 }
  const s = parseHHMM(document.getElementById('lunch-start')?.value)
  const e = parseHHMM(document.getElementById('lunch-end')?.value)
  if (s == null || e == null || e <= s) return { start: 0, end: 0 }
  return { start: s, end: e }
}

// 편집된 구간 + 점심시간 → worklog 조각 [{ started, seconds }]
function piecesFrom(rows, lunch) {
  const out = []
  for (const r of rows) {
    if (!r.start || !r.end) continue
    out.push(...buildWorklogPiecesFromTimes(r.dateStr, r.start, r.end, lunch))
  }
  return out
}

function previewMins() {
  const secs = piecesFrom(readRows(), readLunch()).reduce((a, p) => a + p.seconds, 0)
  return Math.round(secs / 60)
}

function renderMessage(msg, isError) {
  app().innerHTML = `
    <div class="dlg">
      <p class="${isError ? 'err' : 'dim'}">${esc(msg)}</p>
      <div class="dlg-actions"><button id="dlg-close">닫기</button></div>
    </div>`
  document.getElementById('dlg-close').onclick = () => win.close()
}

function renderForm() {
  const rows = segInitial(session)
  const multi = rows.length > 1
  const segHtml = rows.map((r, i) => `
    <div class="fseg" data-date="${r.dateStr}">
      ${multi ? `<div class="fseg-label">구간 ${i + 1}</div>` : ''}
      <div class="fseg-row">
        <input type="time" class="fin-input fseg-start" value="${r.start}" aria-label="시작 시간" />
        <span class="fseg-arrow">→</span>
        <input type="time" class="fin-input fseg-end" value="${r.end}" aria-label="종료 시간" />
        ${i === rows.length - 1 ? `<button type="button" class="mini-btn" id="seg-now">지금</button>` : ''}
      </div>
    </div>`).join('')

  app().innerHTML = `
    <div class="dlg">
      <div class="dlg-title">작업 종료 — <b>${esc(key)}</b></div>
      <div class="dlg-sub">${esc(session.summary)}</div>
      <div class="fin-section">${multi ? `작업 구간 (${rows.length}건)` : '작업 시간'}</div>
      ${segHtml}
      <div class="fin-section">점심시간 <span class="dim">(이 기록에만 적용)</span></div>
      <div class="lunch-row">
        <input type="time" class="fin-input" id="lunch-start" value="${fmtHHMM(defaultLunch.start)}" aria-label="점심 시작" />
        <span class="fseg-arrow">~</span>
        <input type="time" class="fin-input" id="lunch-end" value="${fmtHHMM(defaultLunch.end)}" aria-label="점심 종료" />
        <label class="lunch-skip"><input type="checkbox" id="lunch-skip" /> 차감 안 함</label>
      </div>
      <div class="dlg-time">기록할 시간 <b id="prev-mins">${fmtMinutes(previewMins())}</b> <span class="dim" id="prev-note"></span></div>
      <textarea id="cmt" rows="2" placeholder="코멘트(선택)"></textarea>
      <div class="dlg-actions">
        <button id="dlg-cancel">취소</button>
        <button id="dlg-ok" class="primary">Jira에 기록</button>
      </div>
      <div id="dlg-err" class="err"></div>
    </div>`

  document.getElementById('dlg-cancel').onclick = () => win.close()
  document.getElementById('dlg-ok').onclick = submit
  // 마지막(활성) 구간의 종료 시각을 현재로
  document.getElementById('seg-now')?.addEventListener('click', () => {
    const ends = document.querySelectorAll('.fseg-end')
    const last = ends[ends.length - 1]
    if (last) { last.value = hhmm(new Date()); refreshPreview() }
  })
  // 시간/점심 입력 변경 → 미리보기 갱신
  document.querySelectorAll('.fseg-start, .fseg-end, #lunch-start, #lunch-end').forEach(el => {
    el.addEventListener('input', refreshPreview)
  })
  const skip = document.getElementById('lunch-skip')
  skip.addEventListener('change', () => {
    document.getElementById('lunch-start').disabled = skip.checked
    document.getElementById('lunch-end').disabled = skip.checked
    refreshPreview()
  })
  refreshPreview()
  document.getElementById('cmt').focus()
}

function refreshPreview() {
  const el = document.getElementById('prev-mins')
  if (el) el.textContent = fmtMinutes(previewMins())
  const note = document.getElementById('prev-note')
  if (note) {
    const l = readLunch()
    note.textContent = l.end > l.start ? '· 점심 제외' : '· 점심 차감 안 함'
  }
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
      // 첫 제출에서 편집값 기준으로 조각/코멘트 고정 — 재시도 시 다른 조각이 만들어지는 것을 방지
      if (!frozenPieces) {
        // 제출 직전 세션 존재 재검증 — 다이얼로그가 열려 있는 사이 같은 세션이
        // 웹앱/위젯에서 종료·교체됐을 수 있다. 편집한 시간 값은 그대로 사용한다.
        const fresh = await getSessions()
        const cur = (fresh.sessions || []).find(s => s.issueKey === key)
        if (!cur) throw new Error('세션이 이미 종료되었거나 다른 일감으로 변경되었습니다. 창을 닫고 다시 확인해주세요.')
        session = cur
        frozenPieces = piecesFrom(readRows(), readLunch())
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
      // 일부라도 기록됨 — 남은 조각과 코멘트가 고정됐으므로 코멘트/시간 수정 잠금
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
    defaultLunch = await loadDefaultLunch()
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
