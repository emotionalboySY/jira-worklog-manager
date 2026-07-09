// Jira → 우리 서버 동적 웹훅 수신 엔드포인트.
//
// Jira가 이슈 변경 시 POST /api/webhook?k=<불투명토큰> 로 호출한다.
// 토큰으로 사용자(accountId)를 역매핑해 changes:{accountId} 카운터를 +1 한다.
// 브라우저는 별도 폴링(/api/sessions 응답의 jiraRev)으로 이 증가를 감지해 재로드한다.
//
// 인증: Atlassian 3LO 동적 웹훅은 기본 서명(HMAC/JWT)이 없으므로, 등록 시 콜백 URL에
//       심어둔 고엔트로피 불투명 토큰(?k=)이 공유 시크릿 역할을 한다. 토큰 불일치/누락이면
//       조용히 200으로 응답한다(정보 누출 방지 + Jira 재시도 폭주 방지).
import { getRedis } from './_identity.js'

export default async function handler(req, res) {
  // 서버-서버 호출(브라우저 아님) → CORS 불필요. 항상 빠르게 200.
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).end()

  const token = typeof req.query?.k === 'string' ? req.query.k : ''
  if (!token) return res.status(200).json({ ok: true }) // 토큰 없음 → 조용히 무시

  try {
    const redis = getRedis()
    const accountId = await redis.get(`whooktok:${token}`)
    if (accountId && typeof accountId === 'string') {
      // 변경 신호만 올린다(어떤 필드가 바뀌었는지는 불필요 — 클라가 전량 재조회).
      await redis.incr(`changes:${accountId}`)
    }
  } catch (e) {
    // 수신 처리에 실패해도 Jira엔 200 — 5분 자동 리로드 폴백이 있으므로 재시도 유발 안 함.
    console.error('[webhook] 처리 실패:', e?.message)
  }
  return res.status(200).json({ ok: true })
}
