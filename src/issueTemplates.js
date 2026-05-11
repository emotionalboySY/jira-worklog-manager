// Jira createmeta가 description 기본값을 안 내려주는 경우 사용할 fallback 양식.
// jira 스킬에 정의된 이슈 유형별 양식과 동일한 구조를 ADF로 표현.
// 이슈 유형 이름(t.name)으로 매칭. 매칭되는 양식이 없으면 null 반환 → 빈 설명으로 시작.

const h1 = (text) => ({
  type: 'heading',
  attrs: { level: 1 },
  content: [{ type: 'text', text }],
})

const p = (text) => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : [],
})

const hr = () => ({ type: 'rule' })

const doc = (...content) => ({ type: 'doc', version: 1, content })

// 스토리 / 작업 / 에픽 — 공통
const STORY_LIKE = doc(
  h1('작업 배경'),
  p('(이 작업을 시작하게 된 배경)'),
  hr(),
  h1('작업 내용'),
  p('(실질적으로 수행해야 하는 task)'),
  hr(),
  h1('기대 효과 및 완료 조건'),
  p('(이해관계자에게 보여지는 최종 output)'),
  hr(),
  h1('관련 URL'),
  p('(Slack Thread, Gleap 티켓 등)'),
)

const REQUEST = doc(
  h1('요청자'),
  p('(원요청자 이름/소속)'),
  hr(),
  h1('작업 내용'),
  p('(실질적으로 수행해야 하는 task)'),
  hr(),
  h1('기대 효과 및 완료 조건'),
  p('(이해관계자에게 보여지는 최종 output)'),
  hr(),
  h1('관련 URL'),
  p('(Slack Thread, Gleap 티켓 등)'),
)

const OPERATION = doc(
  h1('작업 내용'),
  p('(실질적으로 수행해야 하는 task)'),
  hr(),
  h1('관련 URL'),
  p('(Slack Thread, Gleap 티켓 등)'),
)

const BUG = doc(
  h1('문제 상황 개요'),
  p('(문제 상황 설명 — 발생 환경, 관련 학생/사용자 정보 포함)'),
  hr(),
  h1('재현 방법'),
  p('(해당 오류를 재현하는 단계별 방법)'),
  hr(),
  h1('작업 내용'),
  p('(수정을 위해 실질적으로 수행해야 하는 task)'),
  hr(),
  h1('기대 효과 및 완료 조건'),
  p('(정상 동작 기준)'),
  hr(),
  h1('관련 URL'),
  p('(Slack Thread, Gleap 티켓 등)'),
)

const HOTFIX = doc(
  h1('서비스 영향 범위'),
  p('(서비스 운영에 지장을 주는 구체적인 부분 — 영향받는 기능, 사용자 범위 등)'),
  hr(),
  h1('재현 방법'),
  p('(해당 오류를 재현하는 단계별 방법)'),
  hr(),
  h1('작업 내용'),
  p('(즉시 수행해야 하는 수정 task)'),
  hr(),
  h1('기대 효과 및 완료 조건'),
  p('(정상 복구 기준)'),
  hr(),
  h1('관련 URL'),
  p('(Slack Thread, Gleap 티켓 등)'),
)

// Jira 이슈 유형 이름 → 양식. 키는 localizedName(한국어) 기준.
const TEMPLATES_BY_TYPE_NAME = {
  '스토리': STORY_LIKE,
  '작업': STORY_LIKE,
  '에픽': STORY_LIKE,
  '하위 작업': STORY_LIKE,
  '요청': REQUEST,
  '운영': OPERATION,
  '버그': BUG,
  '핫픽스': HOTFIX,
}

// 매칭되는 양식 반환. 없으면 null. 안전을 위해 deep copy해서 돌려준다.
export function getFallbackTemplateForType(typeName) {
  const tpl = TEMPLATES_BY_TYPE_NAME[typeName]
  return tpl ? JSON.parse(JSON.stringify(tpl)) : null
}
