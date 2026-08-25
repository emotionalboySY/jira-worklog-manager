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
import { buildWorklogPiecesFromTimes, resolveTimeRange, DEFAULT_LUNCH } from '../../lib/worklogLogic.js'

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

// 현재 DOM의 구간 입력값 읽기 ('다음 날' 토글 의도 포함)
// nextDay: 사용자가 직접 토글했으면 그 값, 아니면 null(자동 판정 — 6시간 이내만 자정 넘김 인정)
function readRows() {
  return [...document.querySelectorAll('.fseg')].map(row => {
    const box = row.querySelector('.fseg-nextday')
    return {
      row,
      dateStr: row.dataset.date,
      start: row.querySelector('.fseg-start')?.value || '',
      end: row.querySelector('.fseg-end')?.value || '',
      nextDay: box && box.dataset.user === '1' ? box.checked : null,
    }
  })
}

// 무효 구간 안내 문구
function rangeMessage(res) {
  if (res.reason === 'reversed') return "종료 시간이 시작 시간보다 이릅니다. 자정을 넘겨 일한 게 맞다면 '다음 날'을 체크하세요."
  return '종료 시간은 시작 시간보다 이후여야 합니다.'
}

// 구간 행의 '다음 날' 토글 노출/체크 상태를 판정 결과에 맞춘다.
// 종료<시작일 때만 보이고, 사용자가 직접 만지기 전까지는 자동 판정값을 따른다.
function syncNextDay(row, res) {
  const wrap = row.querySelector('.next-day')
  const box = row.querySelector('.fseg-nextday')
  if (!wrap || !box) return
  if (!res.overnightEligible) {
    wrap.hidden = true
    wrap.classList.remove('warn')
    box.checked = false
    delete box.dataset.user
    return
  }
  wrap.hidden = false
  if (box.dataset.user !== '1') box.checked = !!res.crossesMidnight
  wrap.classList.toggle('warn', !box.checked)
}

// 구간별 판정 → { minutes, problems }. 시간이 비어 있는 행은 건너뛴다.
function analyzeRows(rows, lunch) {
  let minutes = 0
  const problems = []
  rows.forEach((r, i) => {
    const res = resolveTimeRange(r.start, r.end, r.nextDay)
    if (r.row) syncNextDay(r.row, res)
    if (res.reason === 'empty') return
    if (!res.valid) {
      problems.push(rows.length > 1 ? `구간 ${i + 1}: ${rangeMessage(res)}` : rangeMessage(res))
      return
    }
    const secs = buildWorklogPiecesFromTimes(r.dateStr, r.start, r.end, lunch, r.nextDay)
      .reduce((a, p) => a + p.seconds, 0)
    minutes += Math.round(secs / 60)
  })
  return { minutes, problems }
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
    out.push(...buildWorklogPiecesFromTimes(r.dateStr, r.start, r.end, lunch, r.nextDay))
  }
  return out
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
      <label class="next-day" hidden><input type="checkbox" class="fseg-nextday" /> 다음 날</label>
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
      <div class="dlg-time">기록할 시간 <b id="prev-mins">-</b> <span class="dim" id="prev-note"></span></div>
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
  // '다음 날'(자정 넘김) 토글 — 직접 만졌다는 표시를 남겨 자동 판정이 덮어쓰지 않게 한다
  document.querySelectorAll('.fseg-nextday').forEach(box => {
    box.addEventListener('change', () => { box.dataset.user = '1'; refreshPreview() })
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
  const lunch = readLunch()
  const { minutes, problems } = analyzeRows(readRows(), lunch)
  const el = document.getElementById('prev-mins')
  if (el) el.textContent = problems.length ? '-' : fmtMinutes(minutes)
  const note = document.getElementById('prev-note')
  if (note) note.textContent = lunch.end > lunch.start ? '· 점심 제외' : '· 점심 차감 안 함'
  // 무효 구간이 있으면 사유를 보여주고 기록을 막는다.
  // (한 번이라도 기록이 시작된 뒤엔 조각이 고정되므로 버튼 상태를 건드리지 않는다)
  const errEl = document.getElementById('dlg-err')
  if (errEl && !frozenPieces) errEl.textContent = problems.join('\n')
  const ok = document.getElementById('dlg-ok')
  if (ok && !busy && !frozenPieces) ok.disabled = problems.length > 0
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
        const lunch = readLunch()
        const rows = readRows()
        const { problems } = analyzeRows(rows, lunch)
        if (problems.length) throw new Error(problems.join('\n'))
        frozenPieces = piecesFrom(rows, lunch)
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
