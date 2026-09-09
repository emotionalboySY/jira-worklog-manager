// 오류 신고 / 개선 요청 API — 이 서비스 자체에 대한 피드백을 Redis에 저장한다.
// (Jira 이슈가 아니라 앱 자체 문의이므로 Jira와 무관하게 별도 보관)
//
// GET    /api/feedback?scope=mine|all  → { items, isAdmin }   (all 은 관리자만)
// POST   /api/feedback                 → { type, title, body, context } 저장 → { item, isAdmin }
// PATCH  /api/feedback                 → { id, status?, reply? } 관리자 갱신 → { item }
// DELETE /api/feedback?id=...          → 관리자 삭제 (본인이 보낸 '접수' 상태 항목은 본인도 삭제 가능)
//
// 인증: Authorization: Bearer <Atlassian access token> → accountId 로 사용자 식별.
// 관리자: FEEDBACK_ADMIN_ACCOUNT_IDS 환경변수(쉼표 구분 accountId 목록)에 포함된 사용자.
// 저장:
//   fb:item:{id}          항목 JSON
//   fb:ids                전체 id 목록 (LPUSH — 최신 우선)
//   fb:user:{accountId}   해당 사용자가 보낸 id 목록 (LPUSH — 최신 우선)
//   fb:rate:{accountId}   하루 전송 횟수 (남용 방지)
import { applyCors, safeError } from './_cors.js'
import { getRedis, resolveAccountId } from './_identity.js'

const TYPES = new Set(['bug', 'improve'])
const STATUSES = new Set(['open', 'in_progress', 'done', 'rejected'])
const TITLE_MAX = 100
const BODY_MAX = 4000
const REPLY_MAX = 2000
const LIST_MAX = 300         // 목록 조회 상한 (전체/본인 공통)
const RATE_LIMIT_PER_DAY = 30
// 클라이언트가 함께 보내는 진단 정보 — 허용 키만 저장 (임의 payload 저장 방지)
const CONTEXT_KEYS = ['url', 'view', 'theme', 'userAgent', 'viewport', 'appCommit', 'displayName']
const CONTEXT_VALUE_MAX = 300

function adminIds() {
  return (process.env.FEEDBACK_ADMIN_ACCOUNT_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
}

function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

// 자동 역직렬화(객체) 또는 원문 문자열 양쪽 모두 항목 객체로 정규화
function parseItem(raw) {
  let v = raw
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return null }
  }
  return (v && typeof v === 'object' && typeof v.id === 'string') ? v : null
}

function cleanText(v, max) {
  if (typeof v !== 'string') return ''
  return v.replace(/\r\n/g, '\n').trim().slice(0, max)
}

function cleanContext(ctx) {
  const out = {}
  if (!ctx || typeof ctx !== 'object') return out
  for (const k of CONTEXT_KEYS) {
    const v = ctx[k]
    if (typeof v === 'string' && v) out[k] = v.slice(0, CONTEXT_VALUE_MAX)
  }
  return out
}

// id 목록(list key) → 항목 배열 (없어진 항목은 제외)
async function loadItems(redis, listKey) {
  const ids = await redis.lrange(listKey, 0, LIST_MAX - 1)
  if (!ids || ids.length === 0) return []
  const raws = await redis.mget(...ids.map(id => `fb:item:${id}`))
  return raws.map(parseItem).filter(Boolean)
}

export default async function handler(req, res) {
  applyCors(req, res, 'GET, POST, PATCH, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()
  res.setHeader('Cache-Control', 'no-store')

  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return res.status(401).json({ error: 'unauthorized' })

  let accountId
  try {
    accountId = await resolveAccountId(token)
  } catch (e) {
    return res.status(500).json(safeError(e, 'feedback/identity'))
  }
  if (!accountId) return res.status(401).json({ error: 'unauthorized' })

  const isAdmin = adminIds().includes(accountId)
  const redis = getRedis()

  try {
    if (req.method === 'GET') {
      const scope = (req.query && req.query.scope) || 'mine'
      if (scope === 'all') {
        if (!isAdmin) return res.status(403).json({ error: 'forbidden' })
        const items = await loadItems(redis, 'fb:ids')
        return res.status(200).json({ items, isAdmin })
      }
      const items = await loadItems(redis, `fb:user:${accountId}`)
      return res.status(200).json({ items, isAdmin })
    }

    if (req.method === 'POST') {
      const b = req.body || {}
      const type = TYPES.has(b.type) ? b.type : null
      const title = cleanText(b.title, TITLE_MAX)
      const body = cleanText(b.body, BODY_MAX)
      if (!type) return res.status(400).json({ error: '문의 유형을 선택하세요.' })
      if (!title) return res.status(400).json({ error: '제목을 입력하세요.' })
      if (!body) return res.status(400).json({ error: '내용을 입력하세요.' })

      // 하루 전송 횟수 제한 (첫 전송 시 24시간 만료 설정)
      const rateKey = `fb:rate:${accountId}`
      const count = await redis.incr(rateKey)
      if (count === 1) await redis.expire(rateKey, 86400)
      if (count > RATE_LIMIT_PER_DAY) {
        return res.status(429).json({ error: '하루 전송 한도를 초과했습니다. 내일 다시 시도해 주세요.' })
      }

      const now = new Date().toISOString()
      const context = cleanContext(b.context)
      const item = {
        id: newId(),
        type,
        title,
        body,
        status: 'open',
        reply: '',
        author: { accountId, displayName: context.displayName || '' },
        context,
        createdAt: now,
        updatedAt: now,
      }
      await redis.set(`fb:item:${item.id}`, JSON.stringify(item))
      await redis.lpush('fb:ids', item.id)
      await redis.lpush(`fb:user:${accountId}`, item.id)
      return res.status(200).json({ item, isAdmin })
    }

    if (req.method === 'PATCH') {
      if (!isAdmin) return res.status(403).json({ error: 'forbidden' })
      const b = req.body || {}
      const id = typeof b.id === 'string' ? b.id : ''
      if (!id) return res.status(400).json({ error: 'id required' })
      const item = parseItem(await redis.get(`fb:item:${id}`))
      if (!item) return res.status(404).json({ error: 'not found' })
      if (b.status !== undefined) {
        if (!STATUSES.has(b.status)) return res.status(400).json({ error: 'invalid status' })
        item.status = b.status
      }
      if (b.reply !== undefined) item.reply = cleanText(b.reply, REPLY_MAX)
      item.updatedAt = new Date().toISOString()
      await redis.set(`fb:item:${id}`, JSON.stringify(item))
      return res.status(200).json({ item })
    }

    if (req.method === 'DELETE') {
      const id = (req.query && typeof req.query.id === 'string') ? req.query.id : ''
      if (!id) return res.status(400).json({ error: 'id required' })
      const item = parseItem(await redis.get(`fb:item:${id}`))
      if (!item) return res.status(404).json({ error: 'not found' })
      const isOwner = item.author?.accountId === accountId
      // 본인은 아직 처리 시작 전(open)인 항목만 회수 가능
      if (!isAdmin && !(isOwner && item.status === 'open')) {
        return res.status(403).json({ error: 'forbidden' })
      }
      await redis.del(`fb:item:${id}`)
      await redis.lrem('fb:ids', 0, id)
      if (item.author?.accountId) await redis.lrem(`fb:user:${item.author.accountId}`, 0, id)
      return res.status(200).json({ ok: true })
    }

    return res.status(405).json({ error: 'method not allowed' })
  } catch (e) {
    return res.status(500).json(safeError(e, 'feedback'))
  }
}
