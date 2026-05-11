// ========== Jira API 호출 모듈 ==========
import { jiraFetch } from './auth.js'
import { toDateString, formatHHMM, formatMinutes } from './utils.js'
import { getFallbackTemplateForType } from './issueTemplates.js'

// 이슈 목록/검색에 필요한 필드. priority/priorityIconUrl은 상세 모달에서만 필요해
// fetchIssueDetail의 별도 fetch에서 가져오도록 분리(목록 응답 크기 절감).
const FIELDS = 'summary,issuetype,status,reporter,assignee,watches,parent'

// 이슈의 parent(상위 항목/에픽) 추출. 없으면 null
function extractParent(fields) {
  const p = fields?.parent
  if (!p || !p.key) return null
  const pf = p.fields || {}
  return {
    key: p.key,
    summary: pf.summary || '',
    type: pf.issuetype?.name || '',
    typeIconUrl: pf.issuetype?.iconUrl || '',
  }
}

// 담당자 정보 추출. 미할당이면 null
// avatarUrls는 Jira가 24/32/48px 버전을 모두 제공 — 목록에 쓸 32px 우선, 없으면 fallback
function extractAssignee(fields) {
  const a = fields?.assignee
  if (!a || !a.accountId) return null
  const urls = a.avatarUrls || {}
  return {
    accountId: a.accountId,
    displayName: a.displayName || '',
    avatarUrl: urls['32x32'] || urls['48x48'] || urls['24x24'] || urls['16x16'] || '',
  }
}

// 모든 페이지 가져오기 (페이지네이션 처리)
// Jira Cloud의 /search/jql 엔드포인트는 startAt + total 기반 페이지네이션을 더 이상
// 지원하지 않고 nextPageToken 토큰 방식만 동작한다. (예전 코드처럼 startAt을 보내면
// 서버가 무시하고 같은 첫 페이지를 계속 돌려줘서 무한 루프가 났었음.)
async function fetchAllPages(jql, fields = FIELDS) {
  const allIssues = []
  const maxResults = 100
  let nextPageToken = null
  // 의도치 않은 무한 루프 안전 차단 (한 번 호출에 최대 1만 건)
  const HARD_LIMIT_PAGES = 100
  let truncated = false

  for (let page = 0; page < HARD_LIMIT_PAGES; page++) {
    let url = `/search/jql?jql=${encodeURIComponent(jql)}&fields=${fields}&maxResults=${maxResults}`
    if (nextPageToken) url += `&nextPageToken=${encodeURIComponent(nextPageToken)}`
    const data = await jiraFetch(url)
    if (!data || !Array.isArray(data.issues)) break

    allIssues.push(...data.issues)

    // isLast=true이거나 nextPageToken이 없으면 마지막 페이지
    if (data.isLast === true) break
    if (!data.nextPageToken) break
    // 같은 토큰을 다시 받으면 서버 측 비정상 — 안전하게 종료
    if (data.nextPageToken === nextPageToken) break

    // 다음 루프가 hard limit을 넘기는지 사전 감지
    if (page === HARD_LIMIT_PAGES - 1) {
      truncated = true
      break
    }
    nextPageToken = data.nextPageToken
  }

  if (truncated) {
    console.warn(`[jira] fetchAllPages: HARD_LIMIT_PAGES(${HARD_LIMIT_PAGES}) 도달 — 결과가 잘렸을 수 있음. JQL: ${jql}`)
  }

  return allIssues
}

// 내 이슈 조회 (할당됨 / 보고자 / 워칭)
export async function fetchMyIssues() {
  const myFilter = '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser())'

  // 1. 활성 상태 이슈: Done 카테고리가 아닌 모든 이슈
  const activeJql = `${myFilter} AND statusCategory != "Done" ORDER BY updated DESC`

  // 2. 완료/보류 이슈: Done 카테고리 + 최근 1개월 내 업데이트된 것만
  const closedJql = `${myFilter} AND statusCategory = "Done" AND updated >= -30d ORDER BY updated DESC`

  // 병렬 조회
  const [activeIssues, closedIssues] = await Promise.all([
    fetchAllPages(activeJql),
    fetchAllPages(closedJql),
  ])

  const allIssues = [...activeIssues, ...closedIssues]

  // 현재 사용자 정보 (역할 판별용)
  const userRaw = localStorage.getItem('jira_user')
  const currentUser = userRaw ? JSON.parse(userRaw) : null
  const myAccountId = currentUser?.accountId

  return allIssues.map(issue => {
    const fields = issue.fields
    const role = determineRole(fields, myAccountId, { assumeWatcher: true })

    return {
      key: issue.key,
      summary: fields.summary,
      type: fields.issuetype?.name || '',
      typeIconUrl: fields.issuetype?.iconUrl || '',
      status: fields.status?.name || '',
      statusCategory: fields.status?.statusCategory?.key || 'new',
      parent: extractParent(fields),
      assignee: extractAssignee(fields),
      role,
    }
  })
}

// assumeWatcher: true면 assignee/reporter 아닐 때 watcher로 간주 (fetchMyIssues처럼 JQL로 내 이슈만 가져온 경우)
// false면 isWatching 값으로만 판단 (직접 key 조회처럼 범위가 불명확한 경우)
function determineRole(fields, myAccountId, { assumeWatcher = false } = {}) {
  if (!myAccountId) return assumeWatcher ? 'watcher' : 'none'
  if (fields.assignee?.accountId === myAccountId) return 'assignee'
  if (fields.reporter?.accountId === myAccountId) return 'reporter'
  if (fields.watches?.isWatching) return 'watcher'
  return assumeWatcher ? 'watcher' : 'none'
}

// 이슈 키 또는 요약 텍스트 검색
export async function searchIssuesByKey(query, projectKeys, { signal } = {}) {
  const userRaw = localStorage.getItem('jira_user')
  const currentUser = userRaw ? JSON.parse(userRaw) : null
  const myAccountId = currentUser?.accountId

  const myFilter = '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser())'

  let jql
  const trimmed = query.trim()
  const isNumeric = /^\d+$/.test(trimmed)

  if (isNumeric) {
    // 숫자만 입력: 모든 프로젝트에서 키 매칭
    const keys = projectKeys.map(p => `"${p}-${trimmed}"`)
    jql = `key in (${keys.join(',')}) ORDER BY key ASC`
  } else {
    const qUpper = trimmed.toUpperCase()
    const keyPattern = /^[A-Z][A-Z0-9]*-\d+$/
    if (keyPattern.test(qUpper)) {
      // 이슈 키 정확 매칭 (예: DKT-123)
      jql = `key = "${qUpper}" ORDER BY key ASC`
    } else if (projectKeys.includes(qUpper)) {
      // 프로젝트 키만 입력 (예: DKT): 프로젝트 내 내 이슈
      jql = `project = "${qUpper}" AND ${myFilter} ORDER BY updated DESC`
    } else {
      // 요약 텍스트 검색 (내 이슈 범위)
      // JQL 문자열 안의 큰따옴표/백슬래시 이스케이프
      const escaped = trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      jql = `summary ~ "${escaped}" AND ${myFilter} ORDER BY updated DESC`
    }
  }

  const data = await jiraFetch(
    `/search/jql?jql=${encodeURIComponent(jql)}&fields=${FIELDS}&maxResults=20`,
    { signal }
  )
  if (!data || !data.issues) return []

  return data.issues.map(issue => {
    const fields = issue.fields
    const role = determineRole(fields, myAccountId)
    return {
      key: issue.key,
      summary: fields.summary,
      type: fields.issuetype?.name || '',
      typeIconUrl: fields.issuetype?.iconUrl || '',
      status: fields.status?.name || '',
      statusCategory: fields.status?.statusCategory?.key || 'new',
      parent: extractParent(fields),
      assignee: extractAssignee(fields),
      role,
    }
  })
}

// ========== 작업 로그(worklog) 조회 ==========

// ADF(Atlassian Document Format)에서 텍스트 추출
function extractPlainText(adfDoc) {
  if (!adfDoc || !adfDoc.content) return ''
  let text = ''
  function walk(nodes) {
    for (const node of nodes) {
      if (node.type === 'text') text += node.text
      if (node.content) walk(node.content)
    }
  }
  walk(adfDoc.content)
  return text
}

// utils.js의 공통 함수 사용 (시간 포맷은 한 곳에서만 관리)
function formatTimeHHMM(date) {
  return formatHHMM(date.getHours() * 60 + date.getMinutes())
}

// 내 작업 로그 조회 (날짜 범위: "YYYY-MM-DD")
export async function fetchMyWorklogs(startDate, endDate) {
  const userRaw = localStorage.getItem('jira_user')
  const currentUser = userRaw ? JSON.parse(userRaw) : null
  const myAccountId = currentUser?.accountId
  if (!myAccountId) return {}

  // 1. 해당 기간에 내가 worklog를 남긴 이슈 검색 + worklog 필드 동봉
  //    (search에 worklog를 포함하면 이슈당 최대 20개 worklog가 같이 옴)
  const jql = `worklogAuthor = currentUser() AND worklogDate >= "${startDate}" AND worklogDate <= "${endDate}" ORDER BY updated DESC`
  const issues = await fetchAllPages(jql, 'summary,worklog')

  const rangeStart = new Date(startDate + 'T00:00:00')
  const rangeEnd = new Date(endDate + 'T23:59:59.999')
  // startedAfter/Before는 exclusive이므로 1ms 조정
  const startMs = rangeStart.getTime() - 1
  const endMs = rangeEnd.getTime() + 1

  // worklog가 maxResults를 초과하는 이슈만 개별 조회로 fallback
  // (일반적으로 월별 조회에서 한 이슈에 worklog가 20개를 넘는 경우는 드묾)
  const worklogsByIssue = new Map()
  const overflowIssues = []
  for (const issue of issues) {
    const wl = issue.fields?.worklog
    const total = wl?.total ?? 0
    const maxResults = wl?.maxResults ?? 20
    const list = wl?.worklogs || []
    if (total > maxResults) {
      overflowIssues.push(issue)
    } else {
      worklogsByIssue.set(issue.key, list)
    }
  }

  if (overflowIssues.length > 0) {
    await Promise.all(overflowIssues.map(async (issue) => {
      const data = await jiraFetch(
        `/issue/${issue.key}/worklog?startedAfter=${startMs}&startedBefore=${endMs}`
      )
      worklogsByIssue.set(issue.key, data?.worklogs || [])
    }))
  }

  const worklogsByDate = {}

  for (const issue of issues) {
    const list = worklogsByIssue.get(issue.key) || []
    list
      .filter(w => {
        if (w.author?.accountId !== myAccountId) return false
        const started = new Date(w.started)
        return started >= rangeStart && started <= rangeEnd
      })
      .forEach(w => {
        const started = new Date(w.started)
        const dateStr = toDateString(started)
        const timeSpentMinutes = Math.round(w.timeSpentSeconds / 60)
        const endTime = new Date(started.getTime() + w.timeSpentSeconds * 1000)

        const entry = {
          worklogId: w.id,
          issueKey: issue.key,
          summary: issue.fields.summary,
          startTime: formatTimeHHMM(started),
          endTime: formatTimeHHMM(endTime),
          durationMinutes: timeSpentMinutes,
          duration: formatMinutes(timeSpentMinutes),
          comment: extractPlainText(w.comment),
        }

        if (!worklogsByDate[dateStr]) worklogsByDate[dateStr] = []
        worklogsByDate[dateStr].push(entry)
      })
  }

  // 각 날짜별 시작시간순 정렬
  for (const date in worklogsByDate) {
    worklogsByDate[date].sort((a, b) => a.startTime.localeCompare(b.startTime))
  }

  return worklogsByDate
}

// 텍스트를 ADF(Atlassian Document Format)로 변환
function textToAdf(text) {
  if (!text) return { type: 'doc', version: 1, content: [] }
  return {
    type: 'doc',
    version: 1,
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text }],
    }],
  }
}

// 작업 로그 수정
export async function updateWorklog(issueKey, worklogId, { started, timeSpentSeconds, comment }) {
  const body = {}
  if (started) body.started = started
  if (timeSpentSeconds) body.timeSpentSeconds = timeSpentSeconds
  if (comment != null) body.comment = textToAdf(comment)
  return jiraFetch(`/issue/${issueKey}/worklog/${worklogId}`, { method: 'PUT', body })
}

// 작업 로그 삭제
export async function deleteWorklog(issueKey, worklogId) {
  return jiraFetch(`/issue/${issueKey}/worklog/${worklogId}`, { method: 'DELETE' })
}

// 작업 로그 생성
export async function createWorklog(issueKey, { started, timeSpentSeconds, comment }) {
  const body = { started, timeSpentSeconds }
  if (comment) body.comment = textToAdf(comment)
  return jiraFetch(`/issue/${issueKey}/worklog`, { method: 'POST', body })
}

// 현재 열린 스프린트에 속한 내 이슈들의 key 목록
export async function fetchActiveSprintIssueKeys() {
  const jql = `(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND sprint in openSprints()`
  const issues = await fetchAllPages(jql)
  return issues.map(i => i.key)
}

// 이슈 단일 조회 (요약 미리보기 및 유효성 검사용)
// 이슈에 대해 현재 가능한 상태 전이 목록 조회 (프로젝트/워크플로우마다 다름)
// expand=transitions.fields로 각 전이의 필수 필드(resolution 등)까지 함께 가져옴
export async function fetchTransitions(issueKey, { signal } = {}) {
  const data = await jiraFetch(
    `/issue/${encodeURIComponent(issueKey)}/transitions?expand=transitions.fields`,
    { signal }
  )
  return data?.transitions || []
}

// ========== Stale-While-Revalidate 메모리 캐시 ==========
// 드롭다운 첫 오픈 후, 같은 세션에서 다시 열 때 즉시 표시되도록 결과를 메모리에 보관.
// TTL이 지나도 즉시 반환은 하되 호출 측이 백그라운드 fetch로 신선화함.
// 상태 전이가 일어난 이슈는 가능한 전이 목록이 바뀌므로 즉시 invalidate.
const transitionsCache = new Map() // issueKey → { data, fetchedAt }
const assignableUsersCache = new Map() // issueKey → { data, fetchedAt }
const issueTypesCache = new Map() // issueKey → { data, fetchedAt }

export function getCachedTransitions(issueKey) {
  return transitionsCache.get(issueKey)?.data || null
}

export function setCachedTransitions(issueKey, data) {
  transitionsCache.set(issueKey, { data, fetchedAt: Date.now() })
}

export function invalidateTransitionsCache(issueKey) {
  transitionsCache.delete(issueKey)
}

export function getCachedAssignableUsers(issueKey) {
  return assignableUsersCache.get(issueKey)?.data || null
}

export function setCachedAssignableUsers(issueKey, data) {
  assignableUsersCache.set(issueKey, { data, fetchedAt: Date.now() })
}

export function getCachedIssueTypes(issueKey) {
  return issueTypesCache.get(issueKey)?.data || null
}

export function setCachedIssueTypes(issueKey, data) {
  issueTypesCache.set(issueKey, { data, fetchedAt: Date.now() })
}

// 전이 실행. fields는 transition에 필요한 추가 데이터 (예: { resolution: { id: '10000' } })
export async function transitionIssue(issueKey, transitionId, fields = null) {
  const body = { transition: { id: String(transitionId) } }
  if (fields && Object.keys(fields).length > 0) body.fields = fields
  return jiraFetch(`/issue/${encodeURIComponent(issueKey)}/transitions`, {
    method: 'POST',
    body,
  })
}

// 전이 후 최신 status/statusCategory 읽기 (낙관적 업데이트 후 서버 값으로 보정)
export async function fetchIssueStatus(issueKey, { signal } = {}) {
  const data = await jiraFetch(
    `/issue/${encodeURIComponent(issueKey)}?fields=status`,
    { signal }
  )
  const s = data?.fields?.status
  if (!s) return null
  return {
    status: s.name || '',
    statusCategory: s.statusCategory?.key || 'new',
  }
}

export async function fetchIssueMeta(issueKey, { signal } = {}) {
  const data = await jiraFetch(
    `/issue/${encodeURIComponent(issueKey)}?fields=summary,issuetype,status`,
    { signal }
  )
  if (!data || !data.key) return null
  const fields = data.fields || {}
  return {
    key: data.key,
    summary: fields.summary || '',
    type: fields.issuetype?.name || '',
    typeIconUrl: fields.issuetype?.iconUrl || '',
    status: fields.status?.name || '',
    statusCategory: fields.status?.statusCategory?.key || 'new',
  }
}

// 프로젝트 목록 조회
export async function fetchProjects() {
  const data = await jiraFetch('/project/search?maxResults=50&orderBy=name')
  if (!data || !data.values) return []
  return data.values.map(p => ({
    key: p.key,
    name: p.name,
  }))
}

// 스프린트 커스텀 필드 ID (확인 완료)
const SPRINT_FIELD = 'customfield_10020'

// 이슈 상세 정보 조회: ADF 설명 + 메타 + 첨부 목록
// renderedFields(서버 HTML)는 구식 위키 마크업 잔재를 망치므로 쓰지 않고,
// 클라이언트에서 ADF를 직접 렌더한다.
export async function fetchIssueDetail(issueKey, { signal } = {}) {
  const fields = [
    'summary', 'issuetype', 'status', 'priority',
    'reporter', 'assignee', 'duedate', 'timetracking',
    'description', 'attachment', 'parent', 'created', 'updated',
    'comment', 'issuelinks',
    SPRINT_FIELD,
  ].join(',')
  const data = await jiraFetch(
    `/issue/${encodeURIComponent(issueKey)}?fields=${fields}`,
    { signal }
  )
  if (!data) return null

  const f = data.fields || {}
  const tt = f.timetracking || {}

  return {
    key: data.key,
    summary: f.summary || '',
    type: f.issuetype?.name || '',
    typeIconUrl: f.issuetype?.iconUrl || '',
    status: f.status?.name || '',
    statusCategory: f.status?.statusCategory?.key || 'new',
    priority: f.priority?.name || '',
    priorityIconUrl: f.priority?.iconUrl || '',
    parent: extractParent(f),
    assignee: extractAssignee(f),
    reporter: extractReporter(f),
    duedate: f.duedate || null,
    originalEstimate: tt.originalEstimate || null,
    timeSpent: tt.timeSpent || null,
    originalEstimateSeconds: tt.originalEstimateSeconds ?? null,
    timeSpentSeconds: tt.timeSpentSeconds ?? null,
    sprints: extractSprints(f[SPRINT_FIELD]),
    descriptionAdf: f.description || null,  // ADF doc or null
    attachments: extractAttachments(f.attachment),
    comments: extractComments(f.comment),
    links: extractIssueLinks(f.issuelinks),
    created: f.created || null,
    updated: f.updated || null,
  }
}

// 이슈 링크 배열 정규화. 각 항목은 {direction: 'inward'|'outward', label, issue: {...}}
// label은 사용자에게 보일 관계 문자열(예: '차단함', '관련됨'). Jira가 한국어 라벨을 내려줌.
function extractIssueLinks(value) {
  if (!Array.isArray(value)) return []
  return value.map(l => {
    const type = l.type || {}
    if (l.outwardIssue) {
      return {
        id: String(l.id || ''),
        direction: 'outward',
        label: type.outward || type.name || '',
        issue: extractLinkedIssue(l.outwardIssue),
      }
    }
    if (l.inwardIssue) {
      return {
        id: String(l.id || ''),
        direction: 'inward',
        label: type.inward || type.name || '',
        issue: extractLinkedIssue(l.inwardIssue),
      }
    }
    return null
  }).filter(x => x && x.issue)
}

function extractLinkedIssue(li) {
  if (!li || !li.key) return null
  const f = li.fields || {}
  return {
    key: li.key,
    summary: f.summary || '',
    typeName: f.issuetype?.name || '',
    typeIconUrl: f.issuetype?.iconUrl || '',
    status: f.status?.name || '',
    statusCategory: f.status?.statusCategory?.key || 'new',
  }
}

// 이슈 설명 업데이트. adfDoc은 ADF doc 객체 또는 null(설명 비우기)
export async function updateIssueDescription(issueKey, adfDoc) {
  await jiraFetch(
    `/issue/${encodeURIComponent(issueKey)}`,
    { method: 'PUT', body: { fields: { description: adfDoc } } }
  )
}

export async function updateIssueSummary(issueKey, summary) {
  await jiraFetch(
    `/issue/${encodeURIComponent(issueKey)}`,
    { method: 'PUT', body: { fields: { summary } } }
  )
}

// 해당 이슈에 할당 가능한 사용자 전체 조회. 검색은 클라이언트 측에서 처리.
export async function fetchAssignableUsers(issueKey, { signal } = {}) {
  // Jira Cloud 기본 max는 1000. 100이면 사실상 전원 커버.
  const data = await jiraFetch(
    `/user/assignable/search?issueKey=${encodeURIComponent(issueKey)}&query=&maxResults=100`,
    { signal }
  )
  if (!Array.isArray(data)) return []
  return data.map(u => {
    const urls = u.avatarUrls || {}
    return {
      accountId: u.accountId,
      displayName: u.displayName || '',
      emailAddress: u.emailAddress || '',
      avatarUrl: urls['32x32'] || urls['48x48'] || urls['24x24'] || urls['16x16'] || '',
    }
  })
}

// 이슈 담당자 변경. accountId=null/빈값이면 미할당
export async function updateIssueAssignee(issueKey, accountId) {
  await jiraFetch(
    `/issue/${encodeURIComponent(issueKey)}/assignee`,
    { method: 'PUT', body: { accountId: accountId || null } }
  )
}

// ========== 댓글 ==========
// Cloud는 ADF doc을 body로 받음.
export async function addIssueComment(issueKey, adfBody) {
  const data = await jiraFetch(
    `/issue/${encodeURIComponent(issueKey)}/comment`,
    { method: 'POST', body: { body: adfBody } }
  )
  return extractComment(data)
}

export async function updateIssueComment(issueKey, commentId, adfBody) {
  const data = await jiraFetch(
    `/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
    { method: 'PUT', body: { body: adfBody } }
  )
  return extractComment(data)
}

export async function deleteIssueComment(issueKey, commentId) {
  await jiraFetch(
    `/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
    { method: 'DELETE' }
  )
}

// 본인 정보 — 댓글 수정/삭제 권한 가늠용 (accountId 비교)
let _myselfPromise = null
let _myselfCache = null
export async function fetchMyself() {
  if (_myselfCache) return _myselfCache
  if (_myselfPromise) return _myselfPromise
  _myselfPromise = (async () => {
    try {
      const data = await jiraFetch('/myself')
      if (!data?.accountId) return null
      const urls = data.avatarUrls || {}
      _myselfCache = {
        accountId: data.accountId,
        displayName: data.displayName || '',
        avatarUrl: urls['32x32'] || urls['48x48'] || urls['24x24'] || urls['16x16'] || '',
      }
      return _myselfCache
    } catch (e) {
      console.warn('현재 사용자 조회 실패:', e)
      return null
    } finally {
      _myselfPromise = null
    }
  })()
  return _myselfPromise
}

export function getCachedMyself() {
  return _myselfCache
}

// 이 이슈에 대해 변경 가능한 이슈 유형 목록 조회.
// editmeta가 issuetype 필드의 allowedValues를 직접 알려준다.
export async function fetchIssueTypes(issueKey, { signal } = {}) {
  const data = await jiraFetch(
    `/issue/${encodeURIComponent(issueKey)}/editmeta`,
    { signal }
  )
  const allowed = data?.fields?.issuetype?.allowedValues || []
  return allowed.map(t => ({
    id: String(t.id),
    name: t.name || '',
    iconUrl: t.iconUrl || '',
    subtask: !!t.subtask,
  }))
}

// 이슈 유형 변경
export async function updateIssueType(issueKey, typeId) {
  await jiraFetch(
    `/issue/${encodeURIComponent(issueKey)}`,
    { method: 'PUT', body: { fields: { issuetype: { id: String(typeId) } } } }
  )
}

// ========== 새 이슈 생성 메타/생성/링크 ==========
// 프로젝트의 createmeta: 사용 가능한 issuetype + 각 type의 필드 메타.
// expand=projects.issuetypes.fields 로 필드까지 함께 받음.
export async function fetchCreateMeta(projectKey, { signal } = {}) {
  const data = await jiraFetch(
    `/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes.fields`,
    { signal }
  )
  const proj = (data?.projects || [])[0]
  if (!proj) return { issuetypes: [] }
  const issuetypes = (proj.issuetypes || [])
    // 서브태스크는 부모가 필요해서 일반 생성에서 제외
    .filter(t => !t.subtask)
    .map(t => {
      const fields = t.fields || {}
      const fieldKeys = Object.keys(fields)
      // 설명 기본값(템플릿) — 보통 ADF doc. Jira Cloud의 Description Templates 기능은
      // createmeta로 노출되지 않으므로, 응답이 비어있으면 이름으로 매칭되는 fallback 양식 사용.
      const descField = fields.description || {}
      const descDefault = descField.hasDefaultValue && descField.defaultValue
        ? descField.defaultValue
        : getFallbackTemplateForType(t.name || '')
      return {
        id: String(t.id),
        name: t.name || '',
        iconUrl: t.iconUrl || '',
        availableFields: fieldKeys,
        hasDuedate: fieldKeys.includes('duedate'),
        requiredFields: fieldKeys.filter(k => fields[k]?.required && !fields[k]?.hasDefaultValue),
        descriptionDefaultAdf: descDefault,
      }
    })
  return { issuetypes }
}

// 이슈 생성. 반환: { key, id, self }
// fields는 호출 측이 구성해서 전달 (summary, issuetype, project, assignee, duedate, description...)
export async function createIssue(fields) {
  return jiraFetch(`/issue`, { method: 'POST', body: { fields } })
}

// 사이트 전체에서 사용 가능한 이슈 링크 타입 목록 (Blocks, Relates 등)
let _linkTypesCache = null
export async function fetchIssueLinkTypes() {
  if (_linkTypesCache) return _linkTypesCache
  const data = await jiraFetch('/issueLinkType')
  const list = (data?.issueLinkTypes || []).map(t => ({
    id: String(t.id),
    name: t.name || '',
    inward: t.inward || '',
    outward: t.outward || '',
  }))
  _linkTypesCache = list
  return list
}

// 두 이슈 사이 링크 생성. typeName은 link type의 'name' (예: 'Blocks').
// outward: '주체'(이 일감이 X한다), inward: '대상'.
export async function createIssueLink(typeName, inwardKey, outwardKey) {
  await jiraFetch('/issueLink', {
    method: 'POST',
    body: {
      type: { name: typeName },
      inwardIssue: { key: inwardKey },
      outwardIssue: { key: outwardKey },
    },
  })
}

// 프로젝트 멤버 중 할당 가능한 사용자 (이슈 키 없을 때 — 신규 생성 흐름용)
// query를 서버에 전달해 서버 측 검색 사용 (빈 query는 알파벳 순 첫 1000명).
export async function fetchAssignableUsersForProject(projectKey, query = '', { signal } = {}) {
  const data = await jiraFetch(
    `/user/assignable/search?project=${encodeURIComponent(projectKey)}&query=${encodeURIComponent(query)}&maxResults=1000`,
    { signal }
  )
  if (!Array.isArray(data)) return []
  return data.map(u => {
    const urls = u.avatarUrls || {}
    return {
      accountId: u.accountId,
      displayName: u.displayName || '',
      emailAddress: u.emailAddress || '',
      avatarUrl: urls['32x32'] || urls['48x48'] || urls['24x24'] || urls['16x16'] || '',
    }
  })
}

function extractReporter(fields) {
  const r = fields?.reporter
  if (!r || !r.accountId) return null
  const urls = r.avatarUrls || {}
  return {
    accountId: r.accountId,
    displayName: r.displayName || '',
    avatarUrl: urls['32x32'] || urls['48x48'] || urls['24x24'] || urls['16x16'] || '',
  }
}

// 스프린트 배열에서 이름만 뽑음. active 우선, 없으면 future, 그 외는 제외
function extractSprints(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter(s => s && (s.state === 'active' || s.state === 'future'))
    .map(s => ({ id: s.id, name: s.name || '', state: s.state || '' }))
}

function extractAttachments(value) {
  if (!Array.isArray(value)) return []
  return value.map(a => ({
    id: a.id,
    filename: a.filename || '',
    mimeType: a.mimeType || '',
    size: a.size || 0,
    contentUrl: a.content || '',  // 원본 다운로드 URL
    thumbnailUrl: a.thumbnail || '',
  }))
}

// 댓글 단건 정규화. body는 Cloud의 ADF doc.
function extractComment(c) {
  if (!c) return null
  const a = c.author || {}
  const urls = a.avatarUrls || {}
  return {
    id: String(c.id || ''),
    author: {
      accountId: a.accountId || '',
      displayName: a.displayName || '',
      avatarUrl: urls['32x32'] || urls['48x48'] || urls['24x24'] || urls['16x16'] || '',
    },
    bodyAdf: c.body || null,
    created: c.created || '',
    updated: c.updated || '',
  }
}

function extractComments(value) {
  // 이슈 상세 응답의 comment 필드 형태: { comments: [], total, maxResults, ... }
  const list = Array.isArray(value?.comments) ? value.comments : (Array.isArray(value) ? value : [])
  return list.map(extractComment).filter(Boolean)
}

// 첨부/이미지 바이너리를 인증 프록시로 받아 Blob URL 생성
// 호출 측이 URL.revokeObjectURL로 해제해야 함
export async function fetchAttachmentBlobUrl(url) {
  const accessToken = localStorage.getItem('jira_access_token')
  if (!accessToken || !url) return null

  // 사이트 URL(mysite.atlassian.net)은 api.atlassian.com 경유로 변환
  const apiUrl = toApiAtlassianUrl(url)
  if (!apiUrl) return null

  try {
    const res = await fetch(`/api/attachment?url=${encodeURIComponent(apiUrl)}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      console.warn('첨부 fetch 실패:', res.status, apiUrl)
      return null
    }
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  } catch (e) {
    console.warn('첨부 fetch 예외:', e)
    return null
  }
}

// 다양한 형태의 Jira 리소스 URL을 api.atlassian.com 프록시 형태로 정규화
// - 이미 api.atlassian.com: 그대로
// - <site>.atlassian.net/rest/...: /ex/jira/<cloudId>/rest/...로 변환
// - 상대 경로 /rest/...: 같은 방식으로 변환
// - 그 외: null (외부 이미지 등은 프록시하지 않음)
function toApiAtlassianUrl(url) {
  if (url.startsWith('https://api.atlassian.com/')) return url

  const cloudId = localStorage.getItem('jira_cloud_id')
  if (!cloudId) return null

  // 사이트 호스트 URL → 경로 추출
  const siteMatch = url.match(/^https:\/\/[^/]+\.atlassian\.net(\/.*)$/)
  const path = siteMatch ? siteMatch[1] : (url.startsWith('/') ? url : null)
  if (!path) return null

  // /rest/api/... 나 /rest/agile/... 는 /ex/jira/<cloudId>/rest/... 로 매핑
  if (path.startsWith('/rest/')) {
    return `https://api.atlassian.com/ex/jira/${cloudId}${path}`
  }
  return null
}
