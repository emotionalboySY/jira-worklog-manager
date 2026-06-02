// 일감 교체 다이얼로그(별도 작은 창). ?key=<현재 issueKey> 로 대상 세션을 받는다.
// 내 진행 중 이슈 목록 조회 → 검색·선택 → '확인'으로 swap 액션 실행 →
// 'sessions-changed' 이벤트로 위젯 본체 갱신 → 창 닫기.
import { getCurrentWindow } from '@tauri-apps/api/window'
import { emit } from '@tauri-apps/api/event'
import { getSessions, postSessionAction, fetchMyIssues } from './api.js'

const win = getCurrentWindow()
const oldKey = new URLSearchParams(location.search).get('key')
const NO_ISSUE_KEY = '__NO_ISSUE__'
const isAssign = oldKey === NO_ISSUE_KEY   // 미지정 세션에 일감을 '지정'하는 모드(교체 대상 없음)

let issues = []
let oldSummary = ''
let selected = null    // { key, summary } — '확인' 누르기 전 선택 상태
let busy = false

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function statusClass(cat) {
  if (cat === 'done') return 'st-done'
  if (cat === 'indeterminate') return 'st-prog'
  return 'st-todo'
}

const app = () => document.getElementById('swap-app')

function rowHtml(i) {
  const icon = i.typeIconUrl
    ? `<img class="swap-type" src="${esc(i.typeIconUrl)}" alt="" />`
    : `<span class="swap-type-x">·</span>`
  return `
    <button class="swap-item" data-key="${esc(i.key)}" data-summary="${esc(i.summary)}">
      ${icon}
      <span class="swap-key">${esc(i.key)}</span>
      <span class="swap-summary">${esc(i.summary)}</span>
      <span class="swap-status ${statusClass(i.statusCategory)}">${esc(i.status)}</span>
    </button>`
}
function listHtml(list) {
  if (!list.length) return `<div class="swap-empty dim">표시할 이슈가 없습니다.</div>`
  return list.map(rowHtml).join('')
}

function renderMessage(msg, isError) {
  app().innerHTML = `
    <div class="dlg">
      <p class="${isError ? 'err' : 'dim'}">${esc(msg)}</p>
      <div class="dlg-actions"><button id="dlg-close">닫기</button></div>
    </div>`
  document.getElementById('dlg-close').onclick = () => win.close()
}

function renderList() {
  app().innerHTML = `
    <div class="dlg swap-dlg">
      <div class="dlg-title">${isAssign ? '일감 지정' : '일감 교체'}</div>
      <div class="dlg-sub">${isAssign ? '현재 <b>(일감 미지정)</b>' : `현재 <b>${esc(oldKey)}</b>${oldSummary ? ' · ' + esc(oldSummary) : ''}`}</div>
      <input id="swap-search" class="swap-search" placeholder="키 또는 요약 검색" autocomplete="off" />
      <div class="swap-list" id="swap-list">${listHtml(issues)}</div>
      <div id="swap-err" class="err"></div>
      <div class="dlg-actions">
        <button id="dlg-cancel">취소</button>
        <button id="swap-ok" class="primary" disabled>확인</button>
      </div>
    </div>`
  const search = document.getElementById('swap-search')
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase()
    const f = !q ? issues : issues.filter(i => i.key.toLowerCase().includes(q) || i.summary.toLowerCase().includes(q))
    document.getElementById('swap-list').innerHTML = listHtml(f)
    bindItems()
    restoreSelection()
  })
  search.focus()
  document.getElementById('dlg-cancel').onclick = () => win.close()
  document.getElementById('swap-ok').onclick = () => { if (selected) submit(selected.key, selected.summary) }
  bindItems()
}

function bindItems() {
  document.querySelectorAll('.swap-item').forEach(btn => {
    btn.onclick = () => selectItem(btn.dataset.key, btn.dataset.summary)
  })
}

// 항목 클릭 = 선택만(하이라이트 + 확인 버튼 활성). 실제 교체는 '확인'에서.
function selectItem(key, summary) {
  selected = { key, summary }
  document.querySelectorAll('.swap-item').forEach(b => b.classList.toggle('selected', b.dataset.key === key))
  const ok = document.getElementById('swap-ok')
  if (ok) ok.disabled = false
}
// 검색으로 목록을 다시 그린 뒤 선택 하이라이트 복원.
function restoreSelection() {
  if (!selected) return
  document.querySelectorAll('.swap-item').forEach(b => b.classList.toggle('selected', b.dataset.key === selected.key))
}

async function submit(newKey, newSummary) {
  if (busy || !newKey) return
  if (newKey === oldKey) { win.close(); return }
  busy = true
  const ok = document.getElementById('swap-ok')
  const errEl = document.getElementById('swap-err')
  if (ok) { ok.disabled = true; ok.textContent = '적용 중…' }
  if (errEl) errEl.textContent = ''
  try {
    const { status, data } = await postSessionAction('swap', { oldKey, newKey, newSummary })
    if (status === 200) {
      await emit('sessions-changed')
      await win.close()
    } else {
      if (errEl) errEl.textContent = (data && data.error) || `교체 실패 (${status})`
      busy = false
      if (ok) { ok.disabled = false; ok.textContent = '확인' }
    }
  } catch (e) {
    if (errEl) errEl.textContent = e.message || '교체에 실패했습니다.'
    busy = false
    if (ok) { ok.disabled = false; ok.textContent = '확인' }
  }
}

async function boot() {
  if (!oldKey) { renderMessage('대상 세션이 없습니다.', true); return }
  renderMessage('이슈 목록을 불러오는 중…', false)
  try {
    const [sessData, list] = await Promise.all([getSessions().catch(() => null), fetchMyIssues()])
    const cur = sessData && sessData.sessions ? sessData.sessions.find(s => s.issueKey === oldKey) : null
    oldSummary = (cur && cur.summary) || ''
    issues = list.filter(i => i.key !== oldKey)  // 현재 일감은 목록에서 제외
    renderList()
  } catch (e) {
    renderMessage(e.message || '이슈 목록을 불러오지 못했습니다.', true)
  }
}

boot()
