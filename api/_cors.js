// 공유 CORS / 에러 처리 헬퍼
// Vercel은 api/ 아래 파일을 함수로 배포하지만, 언더스코어(_) 접두사 파일은 라우팅 대상에서 제외됨.

// origin 화이트리스트 결정
//  - ALLOWED_ORIGINS 환경변수가 있으면 그 목록 안의 origin만 허용
//  - 미설정 시 요청의 host와 동일한 origin만 허용 (자기 자신만 호출)
//  - 매칭 실패 시 null 반환 → Allow-Origin 헤더 자체를 내려보내지 않음 → 브라우저가 차단
function getAllowedOrigin(req) {
  const origin = req.headers.origin || ''
  if (!origin) return null

  const raw = process.env.ALLOWED_ORIGINS
  const allowList = raw
    ? raw.split(',').map(s => s.trim()).filter(Boolean)
    : null

  if (allowList && allowList.length > 0) {
    return allowList.includes(origin) ? origin : null
  }

  // fallback: 같은 host의 origin만
  const host = req.headers.host || ''
  if (origin === `https://${host}` || origin === `http://${host}`) return origin
  return null
}

export function applyCors(req, res, methods = 'GET, POST, OPTIONS') {
  const origin = getAllowedOrigin(req)
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', methods)
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Vary', 'Origin')
}

// 내부 에러를 콘솔에만 자세히 남기고, 클라이언트에는 일반 메시지만 노출
export function safeError(err, label = 'api') {
  try { console.error(`[${label}]`, err) } catch {}
  return { error: 'Internal error' }
}
