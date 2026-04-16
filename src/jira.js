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

  // 1. 활성 상태 이슈: 모두 가져오기
  const activeJql = `${myFilter} AND status in ("대기", "준비", "진행중", "검토", "배포대기") ORDER BY updated DESC`

  // 2. 완료/보류 이슈: 최근 1개월 내 업데이트된 것만
  const closedJql = `${myFilter} AND status in ("완료됨", "Closed") AND updated >= -30d ORDER BY updated DESC`

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

// 프로젝트 목록 조회
export async function fetchProjects() {
  const data = await jiraFetch('/project/search?maxResults=50&orderBy=name')
  if (!data || !data.values) return []
  return data.values.map(p => ({
    key: p.key,
    name: p.name,
  }))
}
