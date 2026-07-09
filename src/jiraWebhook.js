// 클라이언트 측 웹훅 보장 트리거.
//
// 로그인 직후 + 주기적으로 /api/webhook-ensure 를 호출해 3LO 동적 웹훅을 등록/갱신한다.
// 실제 Jira 등록/갱신은 서버가 수행하고, 여기서는 유효 토큰과 cloudId만 실어 보낸다.
// 30일 만료 방어: 사용자가 앱을 열 때마다(그리고 장시간 열어둔 탭은 6시간마다) 갱신.
// auth.js는 leaf 모듈이라 순환 없음.
import { ensureAccessToken, refreshAccessToken } from './auth.js'

const RE_ENSURE_MS = 6 * 60 * 60 * 1000 // 6시간마다 재확인(장시간 열어둔 탭 대비)
// 초기화 직후엔 여러 곳이 동시에 토큰을 쓰며(초기 로드/세션 폴/선제 갱신) 신원 캐시가
// 아직 비어 있어 resolveAccountId가 순간적으로 401이 날 수 있다. 살짝 늦춰 레이스를 피한다.
const INITIAL_DELAY_MS = 2500
let timer = null
let startTimer = null

function callEnsure(token) {
  return fetch('/api/webhook-ensure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ cloudId: localStorage.getItem('jira_cloud_id') || '' }),
  })
}

export async function ensureJiraWebhook() {
  try {
    let token = await ensureAccessToken()
    if (!token) return
    let res = await callEnsure(token)
    // 초기화 레이스 등으로 401이면 sessionSync와 동일하게 refresh 후 1회 재시도.
    if (res.status === 401 && await refreshAccessToken()) {
      token = localStorage.getItem('jira_access_token')
      if (token) res = await callEnsure(token)
    }
    // 성공/실패 무관 — 실패해도 5분 자동 리로드 폴백이 동작한다.
  } catch (e) {
    console.warn('웹훅 보장 실패(폴백 사용):', e?.message)
  }
}

export function startWebhookEnsure() {
  // 초기 호출은 지연시켜 인증 정착 후 실행(레이스 회피). 이후 6시간 주기 재확인.
  if (startTimer) clearTimeout(startTimer)
  startTimer = setTimeout(ensureJiraWebhook, INITIAL_DELAY_MS)
  if (timer) clearInterval(timer)
  timer = setInterval(ensureJiraWebhook, RE_ENSURE_MS)
}

export function stopWebhookEnsure() {
  if (startTimer) { clearTimeout(startTimer); startTimer = null }
  if (timer) { clearInterval(timer); timer = null }
}
