// 클라이언트 측 웹훅 보장 트리거.
//
// 로그인 직후 + 주기적으로 /api/webhook-ensure 를 호출해 3LO 동적 웹훅을 등록/갱신한다.
// 실제 Jira 등록/갱신은 서버가 수행하고, 여기서는 유효 토큰과 cloudId만 실어 보낸다.
// 30일 만료 방어: 사용자가 앱을 열 때마다(그리고 장시간 열어둔 탭은 6시간마다) 갱신.
// auth.js는 leaf 모듈이라 순환 없음.
import { ensureAccessToken } from './auth.js'

const RE_ENSURE_MS = 6 * 60 * 60 * 1000 // 6시간마다 재확인(장시간 열어둔 탭 대비)
let timer = null

export async function ensureJiraWebhook() {
  try {
    const token = await ensureAccessToken()
    if (!token) return
    const cloudId = localStorage.getItem('jira_cloud_id') || ''
    await fetch('/api/webhook-ensure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ cloudId }),
    })
  } catch (e) {
    // 실패해도 치명적 아님 — 5분 자동 리로드 폴백이 동작한다.
    console.warn('웹훅 보장 실패(폴백 사용):', e?.message)
  }
}

export function startWebhookEnsure() {
  ensureJiraWebhook()
  if (timer) clearInterval(timer)
  timer = setInterval(ensureJiraWebhook, RE_ENSURE_MS)
}

export function stopWebhookEnsure() {
  if (timer) { clearInterval(timer); timer = null }
}
