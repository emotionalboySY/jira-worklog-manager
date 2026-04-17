// ========== Jira API 호출 모듈 ==========
import { jiraFetch } from './auth.js'

const FIELDS = 'summary,issuetype,status,priority,reporter,assignee,watches'

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
      role,
    }
  })
}

function determineRole(fields, myAccountId) {
  if (!myAccountId) return 'watcher'
  if (fields.assignee?.accountId === myAccountId) return 'assignee'
  if (fields.reporter?.accountId === myAccountId) return 'reporter'
  return 'watcher'
}

// 이슈 타입 목록 조회 (아이콘 URL 포함)
export async function fetchIssueTypes() {
  const data = await jiraFetch('/issuetype')
  if (!Array.isArray(data)) return []
  return data.map(t => ({
    id: t.id,
    name: t.name,
    iconUrl: t.iconUrl,
  }))
}

// 이슈 키 검색
export async function searchIssuesByKey(query, projectKeys) {
  const userRaw = localStorage.getItem('jira_user')
  const currentUser = userRaw ? JSON.parse(userRaw) : null
  const myAccountId = currentUser?.accountId

  let jql
  const isNumeric = /^\d+$/.test(query.trim())

  if (isNumeric) {
    // 숫자만 입력: 모든 프로젝트에서 검색
    const keys = projectKeys.map(p => `"${p}-${query.trim()}"`)
    jql = `key in (${keys.join(',')}) ORDER BY key ASC`
  } else {
    // 프로젝트 키 포함 (예: DKT-123, DKT)
    const q = query.trim().toUpperCase()
    if (q.includes('-')) {
      // 정확한 키 또는 부분 매치
      jql = `key = "${q}" ORDER BY key ASC`
    } else {
      // 프로젝트 접두어만 입력 (예: DKT)
      jql = `project = "${q}" AND (assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) ORDER BY updated DESC`
    }
  }

  const data = await jiraFetch(
    `/search/jql?jql=${encodeURIComponent(jql)}&fields=${FIELDS}&maxResults=20`
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
export async function fetchIssueMeta(issueKey) {
  const data = await jiraFetch(
    `/issue/${encodeURIComponent(issueKey)}?fields=summary,issuetype,status`
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
