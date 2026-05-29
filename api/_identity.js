// 공유 Redis 클라이언트 + Atlassian 신원 해석 헬퍼.
// (언더스코어 접두사 → Vercel 라우팅 대상에서 제외)
import { Redis } from '@upstash/redis'
import { createHash } from 'node:crypto'

// Upstash Redis 클라이언트 (싱글턴).
// Vercel Marketplace Upstash 통합은 UPSTASH_REDIS_REST_* 또는 KV_REST_API_* 로
// env를 주입할 수 있어 양쪽 이름을 모두 허용한다.
let _redis = null
export function getRedis() {
  if (_redis) return _redis
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
  if (!url || !token) {
    throw new Error('Redis 환경변수 미설정 (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)')
  }
  _redis = new Redis({ url, token })
  return _redis
}

// 토큰을 키로 직접 쓰지 않도록 sha256 해시(앞 32자)로 캐시 키 구성.
function tokenKey(accessToken) {
  return 'tok:' + createHash('sha256').update(accessToken).digest('hex').slice(0, 32)
}

// Atlassian access token → accountId 해석.
// 매 폴링마다 Atlassian을 때리지 않도록 token→accountId를 Redis에 5분 캐시.
// 실패(만료/무효 토큰 등) 시 null 반환 → 호출부가 401 처리.
//
// 주의: api.atlassian.com/me 는 read:me scope를 요구하는데 이 앱은 그 scope가 없다.
// 대신 앱이 이미 쓰는 방식(accessible-resources로 cloudId → Jira /myself)을 사용한다.
// 이쪽은 보유 중인 read:jira-user scope만 필요해 확실히 동작한다.
export async function resolveAccountId(accessToken) {
  if (!accessToken) return null
  const redis = getRedis()
  const cacheKey = tokenKey(accessToken)

  const cached = await redis.get(cacheKey)
  if (cached && typeof cached === 'string') return cached

  // 1) 토큰으로 접근 가능한 사이트(cloudId) 조회 — 특수 scope 불필요
  let cloudId
  try {
    const r = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    })
    if (!r.ok) { console.error('[identity] accessible-resources 실패:', r.status); return null }
    const list = await r.json().catch(() => null)
    cloudId = Array.isArray(list) && list[0]?.id
  } catch (e) {
    console.error('[identity] accessible-resources 예외:', e?.message)
    return null
  }
  if (!cloudId) { console.error('[identity] cloudId 없음'); return null }

  // 2) Jira /myself 로 accountId 조회 (read:jira-user scope — 앱 보유)
  let accountId
  try {
    const r = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    })
    if (!r.ok) { console.error('[identity] myself 실패:', r.status); return null }
    const data = await r.json().catch(() => null)
    accountId = data?.accountId
  } catch (e) {
    console.error('[identity] myself 예외:', e?.message)
    return null
  }
  if (!accountId) { console.error('[identity] accountId 없음'); return null }

  await redis.set(cacheKey, accountId, { ex: 300 })
  return accountId
}
