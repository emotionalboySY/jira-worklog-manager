// ========== Jira API 호출 모듈 ==========
import { jiraFetch } from './auth.js'

// 내 이슈 조회 (할당됨 / 보고자 / 워칭)
export async function fetchMyIssues() {
  const jql = 'assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser() ORDER BY updated DESC'
  const fields = 'summary,issuetype,status,priority,reporter,assignee,watches'
  const maxResults = 100

  const data = await jiraFetch(`/search/jql?jql=${encodeURIComponent(jql)}&fields=${fields}&maxResults=${maxResults}`)
  if (!data || !data.issues) return []

  // 현재 사용자 정보 (역할 판별용)
  const userRaw = localStorage.getItem('jira_user')
  const currentUser = userRaw ? JSON.parse(userRaw) : null
  const myAccountId = currentUser?.accountId

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
