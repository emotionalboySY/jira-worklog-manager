// 오류 신고 / 개선 요청 API 클라이언트 — /api/feedback 와 통신.
// sessionSync.js와 같은 방식: 요청 전 ensureAccessToken, 401이면 1회 refresh 후 재시도.
// auth.js는 leaf 모듈이라 import 순환 없음.
import { ensureAccessToken, refreshAccessToken } from './auth.js'

const API = '/api/feedback'

// 빌드 시 vite.config.js 의 define 으로 치환되는 커밋 해시 (dev 서버에서는 'dev')
const APP_COMMIT = typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'dev'
export function getAppCommit() { return APP_COMMIT }

async function request(method, { query = null, body = null } = {}) {
  const token = await ensureAccessToken()
  if (!token) { const e = new Error('로그인이 필요합니다.'); e.status = 401; throw e }
  const url = query ? `${API}?${new URLSearchParams(query)}` : API
  const send = (t) => fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let res = await send(token)
  if (res.status === 401 && await refreshAccessToken()) {
    res = await send(localStorage.getItem('jira_access_token'))
  }
  let data = null
  try { data = await res.json() } catch {}
  if (!res.ok) {
    // 서버가 한국어 안내 문구를 내려준 경우(400/429 등) 그대로 노출
    const msg = (data && typeof data.error === 'string' && data.error !== 'Internal error' && data.error !== 'unauthorized' && data.error !== 'forbidden')
      ? data.error
      : `요청 실패 (${res.status})`
    const e = new Error(msg); e.status = res.status; throw e
  }
  return data
}

// scope: 'mine' | 'all' → { items, isAdmin }
export function fetchFeedback(scope = 'mine') {
  return request('GET', { query: { scope } })
}

// { type, title, body, context } → { item, isAdmin }
export function submitFeedback(payload) {
  return request('POST', { body: payload })
}

// 관리자: { status?, reply? } → { item }
export function updateFeedback(id, patch) {
  return request('PATCH', { body: { id, ...patch } })
}

export function deleteFeedback(id) {
  return request('DELETE', { query: { id } })
}
