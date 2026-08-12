// 활동 기록의 '변경 전 → 변경 후' 비교용 최소 diff 유틸.
// 요약처럼 짧은 값은 단어 단위, 설명처럼 여러 줄인 값은 줄 단위로 비교한다.
// 외부 라이브러리 없이 LCS(최장 공통 부분 수열) DP로 계산하며, 텍스트가 너무 크면
// DP를 포기하고 '통째 교체'로 표시한다 (긴 설명에서 브라우저가 멈추는 것 방지).
import { escapeHtml } from './utils.js'

const MAX_DP_CELLS = 250000   // DP 셀 상한 (약 500x500). 초과 시 통째 교체로 폴백
const DEFAULT_CONTEXT = 2     // 줄 diff에서 변경 줄 앞뒤로 보여줄 동일 줄 수
const MAX_RENDER_LINES = 400  // 한 diff에서 그릴 최대 줄 수 (DOM 폭주 방지)

// 공백도 토큰으로 남겨, diff 결과를 그대로 이어붙이면 원문이 복원되게 한다.
function tokenizeWords(text) {
  return String(text ?? '').split(/(\s+)/).filter(t => t !== '')
}

// 빈 값은 '빈 줄 하나'가 아니라 '줄 없음'으로 다룬다 — 신규 작성(전 값 없음)일 때
// 의미 없는 빈 삭제 줄이 생기는 것을 막는다.
function tokenizeLines(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n')
  return s === '' ? [] : s.split('\n')
}

// 같은 종류가 연속되면 하나로 합침
function pushRun(out, type, token) {
  const last = out[out.length - 1]
  if (last && last.type === type) last.tokens.push(token)
  else out.push({ type, tokens: [token] })
}

function mergeRuns(runs) {
  const out = []
  for (const r of runs) {
    if (!r.tokens.length) continue
    const last = out[out.length - 1]
    if (last && last.type === r.type) last.tokens.push(...r.tokens)
    else out.push({ type: r.type, tokens: [...r.tokens] })
  }
  return out
}

// 표준 LCS DP. 반환: [{ type: 'eq'|'del'|'ins', tokens: [...] }]
function lcsDiff(a, b) {
  const n = a.length
  const m = b.length
  const w = m + 1
  // dp[i][j] = a[i..], b[j..]의 LCS 길이
  const dp = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + (j + 1)] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { pushRun(out, 'eq', a[i]); i++; j++ }
    else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) { pushRun(out, 'del', a[i]); i++ }
    else { pushRun(out, 'ins', b[j]); j++ }
  }
  while (i < n) { pushRun(out, 'del', a[i]); i++ }
  while (j < m) { pushRun(out, 'ins', b[j]); j++ }
  return out
}

// 토큰 배열 두 개 비교. 대부분의 편집은 가운데 일부만 바뀌므로
// 공통 접두/접미를 먼저 잘라내 DP 크기를 줄인다.
export function diffTokens(a, b) {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++

  const aMid = a.slice(head, a.length - tail)
  const bMid = b.slice(head, b.length - tail)

  let mid
  if (!aMid.length && !bMid.length) mid = []
  else if (!aMid.length) mid = [{ type: 'ins', tokens: bMid }]
  else if (!bMid.length) mid = [{ type: 'del', tokens: aMid }]
  else if (aMid.length * bMid.length > MAX_DP_CELLS) {
    mid = [{ type: 'del', tokens: aMid }, { type: 'ins', tokens: bMid }]
  } else {
    mid = lcsDiff(aMid, bMid)
  }

  const runs = []
  if (head > 0) runs.push({ type: 'eq', tokens: a.slice(0, head) })
  runs.push(...mid)
  if (tail > 0) runs.push({ type: 'eq', tokens: a.slice(a.length - tail) })
  return mergeRuns(runs)
}

// 토큰 run 하나를 HTML로. 공백만 있는 변경은 태그 없이 흘려보내 노이즈를 줄인다.
function wrapRun(run, highlight) {
  const text = run.tokens.join('')
  const html = escapeHtml(text)
  if (run.type === 'eq' || !text.trim()) return html
  return highlight === 'del'
    ? `<del class="diff-del">${html}</del>`
    : `<ins class="diff-ins">${html}</ins>`
}

// 한 줄 안에서 삭제·추가를 함께 보여주는 단어 단위 강조 HTML (요약처럼 짧은 값용).
export function renderInlineDiffHtml(from, to) {
  const runs = diffTokens(tokenizeWords(from), tokenizeWords(to))
  return runs.map(r => wrapRun(r, r.type === 'del' ? 'del' : 'ins')).join('')
}

// 한 줄짜리 삭제/추가가 맞붙어 있으면 실제로는 '그 줄을 고친 것'이므로,
// 이전 줄에는 빠진 단어만, 다음 줄에는 새로 들어온 단어만 강조한다.
function renderChangedLinePairHtml(before, after) {
  const runs = diffTokens(tokenizeWords(before), tokenizeWords(after))
  const delHtml = runs.filter(r => r.type !== 'ins').map(r => wrapRun(r, 'del')).join('')
  const insHtml = runs.filter(r => r.type !== 'del').map(r => wrapRun(r, 'ins')).join('')
  return lineHtml('del', delHtml) + lineHtml('ins', insHtml)
}

function lineHtml(kind, innerHtml) {
  const marker = kind === 'del' ? '−' : (kind === 'ins' ? '+' : '')
  return `
    <div class="diff-line diff-line-${kind}">
      <span class="diff-line-marker">${marker}</span>
      <span class="diff-line-text">${innerHtml || '&nbsp;'}</span>
    </div>
  `
}

function skippedHtml(count) {
  return `<div class="diff-line diff-line-skip">⋯ ${count}줄 동일</div>`
}

// 줄 단위 diff HTML. 변경되지 않은 긴 구간은 앞뒤 context 줄만 남기고 접는다.
export function renderLineDiffHtml(from, to, { context = DEFAULT_CONTEXT } = {}) {
  const runs = diffTokens(tokenizeLines(from), tokenizeLines(to))
  // 바뀐 곳이 없으면 축약하지 않고 원문 그대로 보여준다
  const hasChange = runs.some(r => r.type !== 'eq')
  const parts = []
  let lineCount = 0
  let truncated = false

  outer:
  for (let idx = 0; idx < runs.length; idx++) {
    const run = runs[idx]
    if (run.type === 'eq') {
      const lines = run.tokens
      // 앞뒤 context만 남기고 가운데는 '⋯ N줄 동일'로 축약
      const headCount = (!hasChange || idx === 0) ? 0 : context
      const tailCount = (!hasChange || idx === runs.length - 1) ? 0 : context
      if (hasChange && lines.length > headCount + tailCount + 1) {
        for (let i = 0; i < headCount; i++) parts.push(lineHtml('eq', escapeHtml(lines[i])))
        parts.push(skippedHtml(lines.length - headCount - tailCount))
        for (let i = lines.length - tailCount; i < lines.length; i++) parts.push(lineHtml('eq', escapeHtml(lines[i])))
        lineCount += headCount + tailCount + 1
      } else {
        for (const l of lines) parts.push(lineHtml('eq', escapeHtml(l)))
        lineCount += lines.length
      }
      if (lineCount >= MAX_RENDER_LINES) { truncated = true; break }
      continue
    }

    // 삭제 1줄 + 추가 1줄이 붙어 있으면 줄 내부 단어 강조
    const next = runs[idx + 1]
    if (run.type === 'del' && next?.type === 'ins'
      && run.tokens.length === 1 && next.tokens.length === 1) {
      parts.push(renderChangedLinePairHtml(run.tokens[0], next.tokens[0]))
      lineCount += 2
      idx++ // ins run 소비
      if (lineCount >= MAX_RENDER_LINES) { truncated = true; break }
      continue
    }

    for (const l of run.tokens) {
      parts.push(lineHtml(run.type, escapeHtml(l)))
      // 통째 교체로 폴백된 초대형 변경에서 DOM이 폭주하지 않도록 상한을 둔다
      if (++lineCount >= MAX_RENDER_LINES) { truncated = true; break outer }
    }
  }

  if (truncated) {
    parts.push(`<div class="diff-line diff-line-skip">내용이 길어 ${MAX_RENDER_LINES}줄까지만 표시합니다.</div>`)
  }
  return `<div class="diff-lines">${parts.join('')}</div>`
}

export { tokenizeWords, tokenizeLines }
