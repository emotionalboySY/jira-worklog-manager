// Jira → 우리 서버 동적 웹훅 수신 엔드포인트.
//
// Jira가 이슈 변경 시 POST /api/webhook?k=<불투명토큰> 로 호출한다.
// 토큰으로 사용자(accountId)를 역매핑해 두 카운터를 갱신한다:
//   - changes:{accountId} (+1 항상): "데이터가 바뀌었다" 신호 → 클라가 이슈/워크로그 재로드
//   - notify:{accountId}  (+1 조건): 아래 "알림 대상" 판정을 통과할 때만 → 클라가 강조/토스트
//
// 알림 대상(= notify +1) 판정: "내가 우리 앱(웹앱/위젯)으로 한 작업"은 제외하고 나머지만 알린다.
//   - 작성자(actor)가 본인이 아님            → 알림 (남의 변경)
//   - 본인 + 워크로그 전용 변경               → 제외 (웹앱/위젯의 시간 기록)
//   - 본인 + 방금 웹앱에서 편집(selfedit 등록) → 제외 (웹앱 편집; api/proxy가 등록)
//   - 본인 + 그 외(CC 등 외부 도구 편집)       → 알림
// 웹앱은 모든 Jira 호출이 /api/proxy를 거쳐 selfedit에 등록되고, 위젯의 유일한 변경인
// 워크로그는 changelog가 WorklogId/시간 필드뿐이라 "워크로그 전용"으로 걸러진다. CC(MCP)는
// 프록시를 안 거치고 필드를 편집하므로 알림 대상으로 남는다.
//
// 브라우저는 별도 폴링(/api/sessions 응답의 jiraRev·jiraNotifyRev)으로 두 값을 감지한다.
//
// 인증: Atlassian 3LO 동적 웹훅은 기본 서명(HMAC/JWT)이 없으므로, 등록 시 콜백 URL에
//       심어둔 고엔트로피 불투명 토큰(?k=)이 공유 시크릿 역할을 한다. 토큰 불일치/누락이면
//       조용히 200으로 응답한다(정보 누출 방지 + Jira 재시도 폭주 방지).
import { getRedis } from './_identity.js'

// Vercel이 JSON 본문을 파싱하지만 문자열로 올 가능성도 방어해 파싱한다.
function parseBody(req) {
  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { return null } }
  return (body && typeof body === 'object') ? body : null
}

// 변경 작성자(actor) accountId. 없으면 null.
function actorIdOf(body) {
  return (body && body.user && typeof body.user.accountId === 'string') ? body.user.accountId : null
}

// 이슈 키. 없으면 null.
function issueKeyOf(body) {
  return (body && body.issue && typeof body.issue.key === 'string') ? body.issue.key : null
}

// 이 변경이 "워크로그 기록만"인지 — changelog 항목이 전부 워크로그/시간 필드면 true.
// (웹앱·위젯이 세션을 종료하며 남기는 시간 기록. changelog가 없으면 판별 불가 → false)
const WORKLOG_FIELDS = new Set(['WorklogId', 'timespent', 'timeestimate', 'timeoriginalestimate'])
function isWorklogOnlyChange(body) {
  const items = body && body.changelog && body.changelog.items
  if (!Array.isArray(items) || items.length === 0) return false
  return items.every(it => WORKLOG_FIELDS.has(it && it.field))
}

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
      // 데이터 변경 신호는 항상 올린다(클라가 전량 재조회해 화면 최신화).
      await redis.incr(`changes:${accountId}`)

      // 알림 대상 판정
      const body = parseBody(req)
      const actorId = actorIdOf(body)
      let notify = true
      if (actorId && actorId === accountId) {
        // 본인 변경 — 우리 앱(웹앱/위젯) 작업이면 제외, CC 등 외부 편집이면 알림.
        if (isWorklogOnlyChange(body)) {
          notify = false // 워크로그 기록(웹앱/위젯)
        } else {
          const issueKey = issueKeyOf(body)
          if (issueKey && await redis.get(`selfedit:${accountId}:${issueKey}`)) {
            notify = false // 방금 웹앱에서 편집(api/proxy가 등록)
          }
        }
      }
      if (notify) await redis.incr(`notify:${accountId}`)
    }
  } catch (e) {
    // 수신 처리에 실패해도 Jira엔 200 — 5분 자동 리로드 폴백이 있으므로 재시도 유발 안 함.
    console.error('[webhook] 처리 실패:', e?.message)
  }
  return res.status(200).json({ ok: true })
}
