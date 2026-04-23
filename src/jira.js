// ========== Jira API 호출 모듈 ==========
import { jiraFetch } from './auth.js'

const FIELDS = 'summary,issuetype,status,priority,reporter,assignee,watches,parent'

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
async function fetchAllPages(jql) {
  const allIssues = []
  let startAt = 0
  const maxResults = 100

  while (true) {
    const data = await jiraFetch(
      `/search/jql?jql=${encodeURIComponent(jql)}&fields=${FIELDS}&maxResults=${maxResults}&startAt=${startAt}`
    )
    if (!data || !data.issues) break

    allIssues.push(...data.issues)

    if (allIssues.length >= data.total || data.issues.length < maxResults) break
    startAt += maxResults
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
      priority: fields.priority?.name || '',
      priorityIconUrl: fields.priority?.iconUrl || '',
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
      priority: fields.priority?.name || '',
      priorityIconUrl: fields.priority?.iconUrl || '',
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

function formatTimeHHMM(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatDurationStr(minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}분`
  if (m === 0) return `${h}시간`
  return `${h}시간 ${m}분`
}

function toLocalDateStr(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// 내 작업 로그 조회 (날짜 범위: "YYYY-MM-DD")
export async function fetchMyWorklogs(startDate, endDate) {
  const userRaw = localStorage.getItem('jira_user')
  const currentUser = userRaw ? JSON.parse(userRaw) : null
  const myAccountId = currentUser?.accountId
  if (!myAccountId) return {}

  // 1. 해당 기간에 내가 worklog를 남긴 이슈 검색
  const jql = `worklogAuthor = currentUser() AND worklogDate >= "${startDate}" AND worklogDate <= "${endDate}" ORDER BY updated DESC`
  const issues = await fetchAllPages(jql)

  // 2. 각 이슈의 worklog 조회 (병렬)
  const rangeStart = new Date(startDate + 'T00:00:00')
  const rangeEnd = new Date(endDate + 'T23:59:59.999')
  // startedAfter/Before는 exclusive이므로 1ms 조정
  const startMs = rangeStart.getTime() - 1
  const endMs = rangeEnd.getTime() + 1

  const worklogsByDate = {}

  await Promise.all(issues.map(async (issue) => {
    const data = await jiraFetch(
      `/issue/${issue.key}/worklog?startedAfter=${startMs}&startedBefore=${endMs}`
    )
    if (!data || !data.worklogs) return

    data.worklogs
      .filter(w => {
        if (w.author?.accountId !== myAccountId) return false
        const started = new Date(w.started)
        return started >= rangeStart && started <= rangeEnd
      })
      .forEach(w => {
        const started = new Date(w.started)
        const dateStr = toLocalDateStr(started)
        const timeSpentMinutes = Math.round(w.timeSpentSeconds / 60)
        const endTime = new Date(started.getTime() + w.timeSpentSeconds * 1000)

        const entry = {
          worklogId: w.id,
          issueKey: issue.key,
          summary: issue.fields.summary,
          startTime: formatTimeHHMM(started),
          endTime: formatTimeHHMM(endTime),
          durationMinutes: timeSpentMinutes,
          duration: formatDurationStr(timeSpentMinutes),
          comment: extractPlainText(w.comment),
        }

        if (!worklogsByDate[dateStr]) worklogsByDate[dateStr] = []
        worklogsByDate[dateStr].push(entry)
      })
  }))

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
