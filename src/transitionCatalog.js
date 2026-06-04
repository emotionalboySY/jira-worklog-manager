// ========== 전이 카탈로그 (영속 캐시) ==========
// 같은 (프로젝트 | 이슈유형 | 상태) 조합은 워크플로우가 동일하므로 전이 목록과
// 각 전이의 필요 필드(resolution 등)도 동일하다. 이 사실을 이용해 이슈 단위가 아니라
// (project|type|status) 단위로 전이 목록을 localStorage에 영속 캐시한다.
//   - 한 이슈에서 한 번 조회하면 같은 조합의 다른 이슈는 즉시 표시(API 지연 제거).
//   - 새로고침/재접속 후에도 캐시가 유지된다.
//   - 이슈 목록 로드 직후 prewarm으로 화면에 보이는 모든 조합을 미리 채워둔다.
// jira.js의 transitionsCache(메모리·issueKey 단위)는 세션 내 최신값 우선 레이어로 함께 쓴다.
import { state } from './state.js'
import { fetchTransitions, setCachedTransitions } from './jira.js'

const STORAGE_KEY = 'transition_catalog'
// 워크플로우는 거의 바뀌지 않으므로 TTL은 길게. TTL 이내면 백그라운드 재조회도 생략한다.
// (실제 전이가 무효였던 경우는 performTransition 실패 시 즉시 재조회·갱신으로 보정)
const TTL_MS = 12 * 60 * 60 * 1000 // 12시간
const MAX_ENTRIES = 200 // localStorage 비대화 방지용 LRU 상한

let memCatalog = null // { [comboKey]: { transitions, savedAt } }

function loadCatalog() {
  if (memCatalog) return memCatalog
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    memCatalog = (parsed && parsed.entries && typeof parsed.entries === 'object') ? parsed.entries : {}
  } catch {
    memCatalog = {}
  }
  return memCatalog
}

function persist() {
  const entries = loadCatalog()
  try {
    // LRU 캡: savedAt 오름차순으로 초과분 제거
    const keys = Object.keys(entries)
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => (entries[a].savedAt || 0) - (entries[b].savedAt || 0))
      const drop = keys.length - MAX_ENTRIES
      for (let i = 0; i < drop; i++) delete entries[keys[i]]
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries }))
  } catch (e) {
    console.warn('전이 카탈로그 저장 실패:', e)
  }
}

// 카탈로그 전체 비우기. 사용자 전환 시 호출 — 전이 가능 여부는 사용자 권한/조건에
// 따라 달라질 수 있으므로 다른 사용자의 캐시가 섞이지 않도록 로그아웃 시 초기화한다.
export function clearTransitionCatalog() {
  memCatalog = {}
  try { localStorage.removeItem(STORAGE_KEY) } catch {}
}

// 이슈 키에서 프로젝트 키 추출 (예: DKT-123 → DKT)
export function projectKeyFromIssueKey(issueKey) {
  return String(issueKey || '').replace(/-\d+$/, '')
}

function comboKey(projectKey, type, status) {
  return `${projectKey || ''}|${type || ''}|${status || ''}`
}

// state(realIssues / searchResults / 상세 모달 / 연결 항목)에서 이슈의 type/status를 찾는다.
// 카탈로그 키는 (project|type|status)이므로 issueKey만으로 키를 만들려면 type/status가 필요하다.
export function resolveIssueTypeStatus(issueKey) {
  for (const arr of [state.realIssues, state.searchResults]) {
    if (!Array.isArray(arr)) continue
    const found = arr.find(i => i.key === issueKey)
    if (found) return { type: found.type || '', status: found.status || '' }
  }
  const d = state.issueDetailModal?.data
  if (d && d.key === issueKey) return { type: d.type || '', status: d.status || '' }
  const links = state.issueDetailModal?.data?.links
  if (Array.isArray(links)) {
    for (const l of links) {
      if (l.issue?.key === issueKey) return { type: l.issue.typeName || '', status: l.issue.status || '' }
    }
  }
  return null
}

// 조합 단위 직접 조회. 반환: { transitions, fresh } | null
export function getCatalogTransitions(projectKey, type, status) {
  const e = loadCatalog()[comboKey(projectKey, type, status)]
  if (!e || !Array.isArray(e.transitions)) return null
  return { transitions: e.transitions, fresh: (Date.now() - (e.savedAt || 0)) < TTL_MS }
}

// 조합 단위 직접 저장
export function setCatalogTransitions(projectKey, type, status, transitions) {
  if (!Array.isArray(transitions)) return
  const cat = loadCatalog()
  cat[comboKey(projectKey, type, status)] = { transitions, savedAt: Date.now() }
  persist()
}

// issueKey 기준 조회 (type/status는 state에서 해석). 반환: { transitions, fresh } | null
export function getCatalogTransitionsForIssue(issueKey) {
  const ts = resolveIssueTypeStatus(issueKey)
  if (!ts) return null
  return getCatalogTransitions(projectKeyFromIssueKey(issueKey), ts.type, ts.status)
}

// issueKey 기준 저장 (현재 type/status 조합으로 기록)
export function recordTransitionsForIssue(issueKey, transitions) {
  const ts = resolveIssueTypeStatus(issueKey)
  if (!ts) return
  setCatalogTransitions(projectKeyFromIssueKey(issueKey), ts.type, ts.status, transitions)
}

// ========== 사전 캐싱(prewarm) ==========
// 이슈 목록 로드 직후 호출. 화면에 보이는 모든 (project|type|status) 조합 중
// 캐시에 없거나 오래된 것만 골라 백그라운드로 전이 목록을 미리 채운다.
// 동시성을 제한해 API에 부담을 주지 않는다. 실패는 조용히 무시.
export async function prewarmTransitionCatalog(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return
  const cat = loadCatalog()
  const now = Date.now()
  // 조합별 대표 issueKey 1개씩만 모은다.
  const todo = new Map() // comboKey → { issueKey, pk, type, status }
  for (const iss of issues) {
    if (!iss || !iss.key) continue
    const pk = projectKeyFromIssueKey(iss.key)
    const type = iss.type || ''
    const status = iss.status || ''
    const ck = comboKey(pk, type, status)
    const e = cat[ck]
    if (e && (now - (e.savedAt || 0)) < TTL_MS) continue // 이미 신선하면 건너뜀
    if (!todo.has(ck)) todo.set(ck, { issueKey: iss.key, pk, type, status })
  }
  if (todo.size === 0) return

  const jobs = [...todo.values()]
  const CONCURRENCY = 3
  let idx = 0
  async function worker() {
    while (idx < jobs.length) {
      const job = jobs[idx++]
      try {
        const transitions = await fetchTransitions(job.issueKey)
        setCachedTransitions(job.issueKey, transitions)
        setCatalogTransitions(job.pk, job.type, job.status, transitions)
      } catch {
        // 권한/네트워크 등으로 일부 실패해도 전체 prewarm은 계속 진행
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker))
}
