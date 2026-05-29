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

// Atlassian access token → account_id 해석.
// 매 폴링마다 Atlassian을 때리지 않도록 token→accountId를 Redis에 5분 캐시.
// 실패(만료/무효 토큰 등) 시 null 반환 → 호출부가 401 처리.
export async function resolveAccountId(accessToken) {
  if (!accessToken) return null
  const redis = getRedis()
  const cacheKey = tokenKey(accessToken)

  const cached = await redis.get(cacheKey)
  if (cached && typeof cached === 'string') return cached

  // api.atlassian.com/me 는 cloudId 없이 토큰 소유자 프로필을 돌려줌
  const res = await fetch('https://api.atlassian.com/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return null
  const data = await res.json().catch(() => null)
  const accountId = data?.account_id
  if (!accountId) return null

  await redis.set(cacheKey, accountId, { ex: 300 })
  return accountId
}
