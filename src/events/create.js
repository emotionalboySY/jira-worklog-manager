// 새 일감 생성 모달: 열기/닫기, createmeta·담당자·링크 로드, 폼 바인딩, 제출.
// events.js에서 분리. 외부에서는 openCreateIssueModal / closeCreateIssueModal /
// ensureCreateIssueEditor / bindCreateIssueEvents 네 가지만 호출.
import { state, EXCLUDED_CREATE_PROJECT_KEYS } from '../state.js'
import {
  fetchMyself,
  fetchCreateMeta,
  createIssue,
  fetchIssueLinkTypes,
  createIssueLink,
  fetchAssignableUsersForProject,
  searchIssuesByKey,
  getCachedMyself,
  uploadIssueAttachment,
  updateIssueDescription,
} from '../jira.js'
import { isEmptyAdf } from '../adfProsemirror.js'
import {
  createEditorInstance,
  destroyInstanceOnMount,
  getEditorOnMount,
} from '../tiptap.js'
import { showToast } from '../ui.js'
import {
  formatJiraError,
  getProjectKeysOrFallback,
} from '../utils.js'
import { refreshIssues } from '../actions.js'
import {
  isValidIssueKeyFormat,
  renderLinkSuggestionsHtml,
} from '../views/modals.js'
import { render } from '../render.js'
import { on } from './_dom.js'

export function openCreateIssueModal() {
  if (state.showCreateIssue) return
  // 모달의 프로젝트 선택지와 동일하게 제외 키 필터 적용 (MDP 등)
  const projects = (state.realProjects || []).filter(p => !EXCLUDED_CREATE_PROJECT_KEYS.includes(p.key))
  let projectKey = ''
  if (state.currentProject && state.currentProject !== 'ALL' && projects.some(p => p.key === state.currentProject)) {
    projectKey = state.currentProject
  } else if (projects.length > 0) {
    projectKey = projects[0].key
  }
  state.showCreateIssue = {
    projectKey,
    issueTypeId: '',
    summary: '',
    descriptionAdf: null,
    assigneeAccountId: '',  // '' = 미선택, '__UNASSIGNED__' = 미할당, 아니면 accountId
    _selectedAssignee: null,
    duedate: '',
    links: [],  // [{ typeName, direction, targetKeys, query, suggestions, ... }]
    metaByProject: {},
    linkTypes: null,
    assigneeUsersByProject: {},
    assigneeQuery: '',
    // 첫 진입 시 createmeta 응답이 도착하기 전 깜빡임("선택 가능한 이슈 유형이 없습니다")을 막기 위해 true로 시작
    loadingMeta: !!projectKey,
    loadingAssignees: false,
    submitting: false,
    error: null,
    fieldErrors: {},
    _descMount: null,
  }
  // 본인 정보 미리 가져오기 (담당자 옵션에 '나' 표시용)
  fetchMyself().then(() => {
    if (state.showCreateIssue) render({ sections: ['modals'] })
  })
  // 링크 타입 로드 (사이트 단위 캐시)
  fetchIssueLinkTypes().then(types => {
    if (!state.showCreateIssue) return
    state.showCreateIssue.linkTypes = types
    render({ sections: ['modals'] })
  }).catch(err => console.warn('링크 타입 조회 실패:', err))
  render({ sections: ['modals'] })
  if (projectKey) loadCreateMetaFor(projectKey)
}

export function closeCreateIssueModal() {
  const m = state.showCreateIssue
  if (!m || m.submitting) return
  // 의미 있는 입력이 있으면 확인 (단, 자동 적용된 default 양식은 dirty로 안 봄)
  const descMatchesDefault = m._lastAppliedDescDefault &&
    JSON.stringify(m.descriptionAdf || null) === JSON.stringify(m._lastAppliedDescDefault)
  const descDirty = !!m.descriptionAdf && !isEmptyAdf(m.descriptionAdf) && !descMatchesDefault
  const dirty = !!(m.summary?.trim() || descDirty || m.duedate ||
    (m.links || []).some(l => (l.targetKeys || []).length > 0) || m.assigneeAccountId)
  if (dirty && !window.confirm('작성 중인 내용이 있습니다. 닫으시겠습니까?')) return
  // in-flight 검색 정리
  for (const link of (m.links || [])) {
    if (link?._searchController) { try { link._searchController.abort() } catch {} }
    if (link?._searchTimer) clearTimeout(link._searchTimer)
  }
  if (m._descMount) destroyInstanceOnMount(m._descMount)
  state.showCreateIssue = null
  render({ sections: ['modals'] })
}

async function loadCreateMetaFor(projectKey, { isRetry = false } = {}) {
  const m = state.showCreateIssue
  if (!m) return
  // 캐시된 정상 결과만 사용 (빈 결과는 캐시하지 않으므로 재시도 가능)
  if (m.metaByProject[projectKey]) {
    const types = m.metaByProject[projectKey].issuetypes || []
    if (!m.issueTypeId && types.length > 0) m.issueTypeId = types[0].id
    applyTypeDescriptionDefault(m)
    render({ sections: ['modals'] })
    return
  }
  m.loadingMeta = true
  render({ sections: ['modals'] })
  let meta = null
  try {
    meta = await fetchCreateMeta(projectKey)
  } catch (err) {
    console.error('createmeta 조회 실패:', err)
    showToast(`이슈 유형 조회 실패: ${formatJiraError(err)}`, '⚠')
  }
  const cur = state.showCreateIssue
  if (!cur || cur.projectKey !== projectKey) return

  if (meta && meta.issuetypes.length > 0) {
    cur.metaByProject[projectKey] = meta
    if (!cur.issueTypeId) cur.issueTypeId = meta.issuetypes[0].id
    applyTypeDescriptionDefault(cur)
    cur.loadingMeta = false
    render({ sections: ['modals'] })
  } else if (!isRetry) {
    // 빈 결과(서버 콜드 스타트 등)는 캐시하지 않고 짧게 대기 후 1회 자동 재시도
    console.warn(`createmeta 빈 결과: ${projectKey} — 자동 재시도`)
    setTimeout(() => {
      const cur2 = state.showCreateIssue
      if (cur2 && cur2.projectKey === projectKey && !cur2.metaByProject[projectKey]) {
        loadCreateMetaFor(projectKey, { isRetry: true })
      }
    }, 300)
    // loadingMeta는 true로 유지 — 재시도까지 "조회 중..." 표시
  } else {
    // 재시도도 빈 결과 → 사용자가 다른 프로젝트로 갔다가 돌아오는 식의 수동 재시도 필요
    cur.loadingMeta = false
    render({ sections: ['modals'] })
  }

  // 담당자 후보도 함께 로드 (빈 query로 첫 페이지)
  loadCreateAssigneesFor(projectKey, '')
}

// 이슈 유형 변경 시: 사용자가 description을 직접 입력하지 않았다면 새 유형의 기본 양식을 적용.
// "직접 입력하지 않았다"의 판정은 (1) 비어있거나 (2) 직전에 적용한 default와 동일한 경우.
function applyTypeDescriptionDefault(m) {
  if (!m) return
  const meta = m.metaByProject?.[m.projectKey]
  const t = meta?.issuetypes.find(x => x.id === m.issueTypeId)
  const newDefault = t?.descriptionDefaultAdf || null
  const currentJson = JSON.stringify(m.descriptionAdf || null)
  const prevJson = JSON.stringify(m._lastAppliedDescDefault || null)
  const isEmpty = !m.descriptionAdf || isEmptyAdf(m.descriptionAdf)
  const matchesPrev = m._lastAppliedDescDefault && currentJson === prevJson
  if (isEmpty || matchesPrev) {
    m.descriptionAdf = newDefault ? JSON.parse(JSON.stringify(newDefault)) : null
    m._lastAppliedDescDefault = newDefault ? JSON.parse(JSON.stringify(newDefault)) : null
    // tiptap 다시 마운트해야 적용됨
    if (m._descMount) {
      destroyInstanceOnMount(m._descMount)
      m._descMount = null
    }
  }
}

async function loadCreateAssigneesFor(projectKey, query = '') {
  const m = state.showCreateIssue
  if (!m) return
  // 빈 쿼리 + 이미 로드돼 있으면 스킵
  if (!query && Array.isArray(m.assigneeUsersByProject[projectKey])) return
  m.loadingAssignees = true
  render({ sections: ['modals'] })
  try {
    const users = await fetchAssignableUsersForProject(projectKey, query)
    const cur = state.showCreateIssue
    if (!cur || cur.projectKey !== projectKey) return
    cur.assigneeUsersByProject[projectKey] = users
  } catch (err) {
    console.warn('담당자 후보 조회 실패:', err)
  } finally {
    const cur = state.showCreateIssue
    if (cur) cur.loadingAssignees = false
    render({ sections: ['modals'] })
  }
}

export function ensureCreateIssueEditor() {
  const m = state.showCreateIssue
  if (!m) return
  const newMount = document.getElementById('create-issue-desc-editor')
  if (newMount && newMount !== m._descMount) {
    if (m._descMount) destroyInstanceOnMount(m._descMount)
    // 재마운트 시 paste 이미지가 사라지지 않도록 _pendingImages를 다시 mount에 주입
    const pendingPreviews = Object.entries(m._pendingImages || {}).map(([id, e]) => ({
      id, file: e?.file, filename: e?.filename || '',
    })).filter(p => p.file)
    const editor = createEditorInstance(newMount, m.descriptionAdf, {
      autofocus: false,
      onUpdate: (adf) => {
        const cur = state.showCreateIssue
        if (cur) cur.descriptionAdf = adf
      },
      // 새 일감은 아직 issue key가 없어 즉시 업로드 불가 → pending id로 자리만 잡고
      // submit 시 createIssue → uploadAttachment → updateIssueDescription 순으로 처리
      onImagePaste: async (file) => registerPendingImage(file),
      onUploadError: (err) => {
        showToast(`이미지 처리 실패: ${err?.message || '알 수 없는 오류'}`, '⚠')
      },
      pendingPreviews,
    })
    newMount.dataset.tiptapMounted = '1'
    if (m.submitting) editor.setEditable(false)
    m._descMount = newMount
  } else if (!newMount && m._descMount) {
    destroyInstanceOnMount(m._descMount)
    m._descMount = null
  }
}

// paste된 파일을 임시 id로 보관. 실제 업로드는 submit 시 createdKey 확보 후 일괄 처리.
// 반환된 id가 mediaSingle > media.attrs.id로 들어가고, 빈 contentUrl 덕에
// NodeView는 임시 blob URL만으로 즉시 미리보기를 보여준다.
function registerPendingImage(file) {
  const m = state.showCreateIssue
  if (!m) return null
  const ext = (file.type || 'image/png').split('/')[1] || 'png'
  const filename = file.name || `pasted-${Date.now()}.${ext}`
  const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  const pendingId = `pending_${rand}`
  if (!m._pendingImages) m._pendingImages = {}
  m._pendingImages[pendingId] = { file, filename }
  return { id: pendingId, contentUrl: '', filename }
}

// ADF 트리에서 pending media의 id 목록 수집 (등장 순서)
function collectPendingMediaIds(adf) {
  const ids = []
  function walk(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'media' && typeof node.attrs?.id === 'string' && node.attrs.id.startsWith('pending_')) {
      ids.push(node.attrs.id)
    }
    if (Array.isArray(node.content)) for (const c of node.content) walk(c)
  }
  walk(adf)
  return ids
}

// pending media를 포함한 mediaSingle을 통째로 제거 (create 페이로드 정화용)
function stripPendingMediaFromAdf(adf) {
  if (!adf) return adf
  function clean(node) {
    if (!node || typeof node !== 'object') return node
    if (node.type === 'mediaSingle') {
      const child = Array.isArray(node.content) ? node.content[0] : null
      if (child?.type === 'media' && typeof child.attrs?.id === 'string' && child.attrs.id.startsWith('pending_')) {
        return null
      }
    }
    if (!Array.isArray(node.content)) return node
    return { ...node, content: node.content.map(clean).filter(Boolean) }
  }
  return clean(adf)
}

// pending id → 실제 첨부 id로 치환
function replacePendingMediaIds(adf, idMap) {
  if (!adf) return adf
  function visit(node) {
    if (!node || typeof node !== 'object') return node
    let out = node
    if (node.type === 'media' && idMap[node.attrs?.id]) {
      out = { ...node, attrs: { ...node.attrs, id: idMap[node.attrs.id] } }
    }
    if (Array.isArray(out.content)) {
      out = { ...out, content: out.content.map(visit) }
    }
    return out
  }
  return visit(adf)
}

export function bindCreateIssueEvents() {
  const m = state.showCreateIssue
  if (!m) return

  // 프로젝트 변경
  const projSel = document.getElementById('create-issue-project')
  if (projSel) {
    on(projSel, 'change', () => {
      const cur = state.showCreateIssue
      if (!cur) return
      cur.projectKey = projSel.value
      cur.issueTypeId = ''
      // 담당자 선택은 프로젝트 바뀌면 초기화
      cur.assigneeAccountId = ''
      cur._selectedAssignee = null
      cur.assigneeQuery = ''
      cur.fieldErrors = {}
      render({ sections: ['modals'] })
      loadCreateMetaFor(projSel.value)
    })
  }

  // 이슈 유형 선택 (버튼 그룹) — 변경 시 설명 기본값(템플릿) 자동 적용
  document.querySelectorAll('[data-create-type-id]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      const cur = state.showCreateIssue
      if (!cur) return
      cur.issueTypeId = btn.dataset.createTypeId
      applyTypeDescriptionDefault(cur)
      render({ sections: ['modals'] })
    })
  })

  // 요약 input
  const summaryInput = document.getElementById('create-issue-summary')
  if (summaryInput) {
    on(summaryInput, 'input', () => {
      const cur = state.showCreateIssue
      if (!cur) return
      cur.summary = summaryInput.value
      if (cur.fieldErrors?.summary) {
        delete cur.fieldErrors.summary
        render({ sections: ['modals'] })
      }
    })
  }

  // 기한
  const dueInput = document.getElementById('create-issue-duedate')
  if (dueInput) {
    on(dueInput, 'change', () => {
      const cur = state.showCreateIssue
      if (cur) cur.duedate = dueInput.value
    })
  }

  // 담당자 검색 input — query를 서버에 전달 (debounce 250ms)
  const assigneeInput = document.getElementById('create-issue-assignee-input')
  if (assigneeInput) {
    on(assigneeInput, 'input', () => {
      const cur = state.showCreateIssue
      if (!cur) return
      cur.assigneeQuery = assigneeInput.value
      clearTimeout(cur._assigneeSearchTimer)
      cur._assigneeSearchTimer = setTimeout(() => {
        const cur2 = state.showCreateIssue
        if (!cur2) return
        loadCreateAssigneesFor(cur2.projectKey, cur2.assigneeQuery)
      }, 250)
    })
  }

  // 담당자 선택
  document.querySelectorAll('[data-action="pick-create-assignee"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      const cur = state.showCreateIssue
      if (!cur) return
      const id = btn.dataset.assigneeId
      if (id === '__UNASSIGNED__') {
        cur.assigneeAccountId = '__UNASSIGNED__'
        cur._selectedAssignee = null
      } else {
        const me = (typeof getCachedMyself === 'function') ? getCachedMyself() : null
        const candidates = [
          ...(me ? [me] : []),
          ...(cur.assigneeUsersByProject[cur.projectKey] || []),
        ]
        const found = candidates.find(u => u.accountId === id)
        cur.assigneeAccountId = id
        cur._selectedAssignee = found || { accountId: id, displayName: '(알 수 없음)', avatarUrl: '' }
      }
      cur.assigneeQuery = ''
      render({ sections: ['modals'] })
    })
  })

  // 담당자 변경 (칩에서 X)
  document.querySelectorAll('[data-action="clear-create-assignee"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      const cur = state.showCreateIssue
      if (!cur) return
      cur.assigneeAccountId = ''
      cur._selectedAssignee = null
      cur.assigneeQuery = ''
      render({ sections: ['modals'] })
    })
  })

  // 항목 연결: 행 추가 (한 행 = 한 link type, 여러 대상 키)
  const addLinkBtn = document.getElementById('create-issue-add-link')
  if (addLinkBtn) {
    on(addLinkBtn, 'click', () => {
      const cur = state.showCreateIssue
      if (!cur || !cur.linkTypes || cur.linkTypes.length === 0) return
      const first = cur.linkTypes[0]
      cur.links = [
        ...(cur.links || []),
        {
          typeName: first.name,
          direction: 'outward',
          targetKeys: [],
          query: '',
          suggestions: null,
          searching: false,
          activeSuggestionIdx: -1,
        },
      ]
      render({ sections: ['modals'] })
      // 새 행의 검색 input에 포커스
      setTimeout(() => {
        const last = (state.showCreateIssue?.links || []).length - 1
        const input = document.querySelector(`.create-issue-link-search[data-link-idx="${last}"]`)
        input?.focus()
      }, 0)
    })
  }

  // 항목 연결: 행 제거
  document.querySelectorAll('[data-action="remove-create-link"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      const cur = state.showCreateIssue
      if (!cur) return
      const idx = parseInt(btn.dataset.linkIdx, 10)
      const link = cur.links[idx]
      // in-flight search controller 정리
      if (link?._searchController) { try { link._searchController.abort() } catch {} }
      if (link?._searchTimer) clearTimeout(link._searchTimer)
      cur.links.splice(idx, 1)
      cur.fieldErrors = {}
      render({ sections: ['modals'] })
    })
  })

  // 항목 연결: 종류 변경
  document.querySelectorAll('.create-issue-link-type').forEach(sel => {
    on(sel, 'change', () => {
      const cur = state.showCreateIssue
      if (!cur) return
      const idx = parseInt(sel.dataset.linkIdx, 10)
      const [linkId, direction] = String(sel.value).split(':')
      const lt = (cur.linkTypes || []).find(t => t.id === linkId)
      if (!lt) return
      cur.links[idx] = { ...cur.links[idx], typeName: lt.name, direction }
    })
  })

  // 항목 연결: 대상 chip 제거
  document.querySelectorAll('[data-action="remove-link-target"]').forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation()
      const cur = state.showCreateIssue
      if (!cur) return
      const idx = parseInt(btn.dataset.linkIdx, 10)
      const key = btn.dataset.targetKey
      const link = cur.links[idx]
      if (!link) return
      link.targetKeys = (link.targetKeys || []).filter(k => k !== key)
      if (cur.fieldErrors?.[`link-${idx}`]) delete cur.fieldErrors[`link-${idx}`]
      render({ sections: ['modals'] })
    })
  })

  // 항목 연결: 검색 input — query 갱신 + debounce 검색 + dropdown만 부분 갱신 (IME 보존)
  document.querySelectorAll('.create-issue-link-search').forEach(input => {
    on(input, 'input', () => {
      const idx = parseInt(input.dataset.linkIdx, 10)
      const cur = state.showCreateIssue
      if (!cur || !cur.links[idx]) return
      cur.links[idx].query = input.value
      cur.links[idx].activeSuggestionIdx = -1
      // 에러 즉시 해제
      if (cur.fieldErrors?.[`link-${idx}`]) delete cur.fieldErrors[`link-${idx}`]
      triggerLinkSearch(idx)
      refreshLinkSuggestions(idx)
    })
    on(input, 'keydown', (e) => handleLinkSearchKeydown(e, parseInt(input.dataset.linkIdx, 10)))
    on(input, 'focus', () => {
      const idx = parseInt(input.dataset.linkIdx, 10)
      // 포커스 시 기존 query가 있으면 결과 다시 표시
      const cur = state.showCreateIssue
      if (cur?.links[idx]?.query) refreshLinkSuggestions(idx)
    })
  })

  // 항목 연결: 자동완성 항목 클릭 — chip 추가
  // (자동완성 dropdown은 부분 갱신되므로 각 dropdown의 컨테이너에 위임 핸들러)
  document.querySelectorAll('[id^="create-issue-link-suggestions-"]').forEach(container => {
    on(container, 'mousedown', (e) => {
      const item = e.target.closest('[data-action="pick-link-target"]')
      if (!item) return
      e.preventDefault()  // mousedown으로 input blur 방지 → 포커스 유지
      const idx = parseInt(item.dataset.linkIdx, 10)
      pickLinkTarget(idx, item.dataset.key)
    })
  })

  // 취소/제출
  const cancelBtn = document.getElementById('create-issue-cancel')
  if (cancelBtn) on(cancelBtn, 'click', closeCreateIssueModal)
  const submitBtn = document.getElementById('create-issue-submit')
  if (submitBtn) on(submitBtn, 'click', submitCreateIssue)
}

// ===== 항목 연결 자동완성 =====
function refreshLinkSuggestions(idx) {
  const cur = state.showCreateIssue
  if (!cur || !cur.links[idx]) return
  const container = document.getElementById(`create-issue-link-suggestions-${idx}`)
  if (!container) return
  const html = renderLinkSuggestionsHtml(idx, cur.links[idx])
  container.innerHTML = html
  container.style.display = html ? 'block' : 'none'
  // 자동완성 항목 hover로 active 동기화
  container.querySelectorAll('[data-action="pick-link-target"]').forEach(el => {
    el.addEventListener('mouseenter', () => {
      const cur2 = state.showCreateIssue
      if (!cur2 || !cur2.links[idx]) return
      const i = parseInt(el.dataset.suggestIdx, 10)
      cur2.links[idx].activeSuggestionIdx = i
      container.querySelectorAll('[data-action="pick-link-target"]').forEach((it, j) => {
        it.classList.toggle('active', j === i)
      })
    })
  })
}

function triggerLinkSearch(idx) {
  const cur = state.showCreateIssue
  if (!cur || !cur.links[idx]) return
  const link = cur.links[idx]
  const q = (link.query || '').trim()

  // 이전 in-flight 정리
  if (link._searchController) {
    try { link._searchController.abort() } catch {}
    link._searchController = null
  }
  if (link._searchTimer) clearTimeout(link._searchTimer)

  if (!q) {
    link.suggestions = null
    link.searching = false
    return
  }

  link.searching = true
  // 즉시 로딩 표시
  refreshLinkSuggestions(idx)

  link._searchTimer = setTimeout(async () => {
    const controller = new AbortController()
    link._searchController = controller
    try {
      const projectKeys = getProjectKeysOrFallback()
      const results = await searchIssuesByKey(q, projectKeys, { signal: controller.signal })
      if (controller.signal.aborted) return
      const cur2 = state.showCreateIssue
      if (!cur2 || !cur2.links[idx]) return
      const live = cur2.links[idx]
      // 사용자가 그동안 query를 바꿨으면 결과 무시
      if ((live.query || '').trim() !== q) return
      const already = new Set(live.targetKeys || [])
      live.suggestions = results
        .filter(r => !already.has(r.key))
        .slice(0, 12)
        .map(r => ({ key: r.key, summary: r.summary }))
      live.searching = false
      refreshLinkSuggestions(idx)
    } catch (err) {
      if (err?.name === 'AbortError') return
      console.warn('항목 연결 검색 실패:', err)
      const cur2 = state.showCreateIssue
      if (cur2 && cur2.links[idx]) {
        cur2.links[idx].searching = false
        refreshLinkSuggestions(idx)
      }
    } finally {
      if (link._searchController === controller) link._searchController = null
    }
  }, 300)
}

function pickLinkTarget(idx, rawKey) {
  const cur = state.showCreateIssue
  if (!cur || !cur.links[idx]) return
  const link = cur.links[idx]
  const upper = String(rawKey || '').trim().toUpperCase()
  if (!upper) return
  if (!(link.targetKeys || []).includes(upper)) {
    link.targetKeys = [...(link.targetKeys || []), upper]
  }
  link.query = ''
  link.suggestions = null
  link.activeSuggestionIdx = -1
  if (cur.fieldErrors?.[`link-${idx}`]) delete cur.fieldErrors[`link-${idx}`]
  render({ sections: ['modals'] })
  // 칩 추가 후 같은 input에 다시 포커스
  setTimeout(() => {
    const input = document.querySelector(`.create-issue-link-search[data-link-idx="${idx}"]`)
    input?.focus()
  }, 0)
}

function handleLinkSearchKeydown(e, idx) {
  // IME 조합 중 ArrowDown/Up은 일부 환경에서 가로채지므로 무시
  if (e.isComposing) return
  const cur = state.showCreateIssue
  if (!cur || !cur.links[idx]) return
  const link = cur.links[idx]
  const sugg = link.suggestions || []
  if (e.key === 'ArrowDown') {
    if (sugg.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    const next = ((link.activeSuggestionIdx ?? -1) + 1) % sugg.length
    link.activeSuggestionIdx = next
    refreshLinkSuggestions(idx)
  } else if (e.key === 'ArrowUp') {
    if (sugg.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    const cur_idx = link.activeSuggestionIdx ?? -1
    const prev = cur_idx <= 0 ? sugg.length - 1 : cur_idx - 1
    link.activeSuggestionIdx = prev
    refreshLinkSuggestions(idx)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (link.activeSuggestionIdx >= 0 && sugg[link.activeSuggestionIdx]) {
      pickLinkTarget(idx, sugg[link.activeSuggestionIdx].key)
    } else {
      const q = (link.query || '').trim().toUpperCase()
      if (isValidIssueKeyFormat(q)) pickLinkTarget(idx, q)
    }
  } else if (e.key === 'Backspace' && !link.query && (link.targetKeys || []).length > 0) {
    e.preventDefault()
    link.targetKeys = link.targetKeys.slice(0, -1)
    render({ sections: ['modals'] })
    setTimeout(() => {
      const input = document.querySelector(`.create-issue-link-search[data-link-idx="${idx}"]`)
      input?.focus()
    }, 0)
  } else if (e.key === 'Escape') {
    if (link.suggestions || link.query) {
      e.preventDefault()
      link.query = ''
      link.suggestions = null
      link.activeSuggestionIdx = -1
      const input = document.querySelector(`.create-issue-link-search[data-link-idx="${idx}"]`)
      if (input) input.value = ''
      refreshLinkSuggestions(idx)
    }
  }
}

async function submitCreateIssue() {
  const m = state.showCreateIssue
  if (!m || m.submitting) return

  // 검증
  const errors = {}
  if (!m.projectKey) errors.summary = '프로젝트를 선택하세요.'
  if (!m.issueTypeId) errors.summary = '이슈 유형을 선택하세요.'
  if (!m.summary || !m.summary.trim()) errors.summary = '요약을 입력하세요.'
  // 링크 행 검증 — 행마다 1개 이상의 대상 키
  ;(m.links || []).forEach((link, i) => {
    const keys = (link.targetKeys || []).map(k => String(k || '').trim().toUpperCase()).filter(Boolean)
    if (keys.length === 0) {
      errors[`link-${i}`] = '연결할 이슈를 한 개 이상 추가하세요.'
      return
    }
    const bad = keys.find(k => !isValidIssueKeyFormat(k))
    if (bad) errors[`link-${i}`] = `이슈 키 형식이 올바르지 않습니다: ${bad}`
  })
  if (Object.keys(errors).length > 0) {
    m.fieldErrors = errors
    m.error = null
    render({ sections: ['modals'] })
    return
  }

  // payload 구성 — pending 이미지가 있으면 create 시점엔 빼고 보냈다가 사후 update
  const descFull = m.descriptionAdf || null
  const pendingIds = collectPendingMediaIds(descFull)
  const hasPending = pendingIds.length > 0
  const descForCreate = hasPending ? stripPendingMediaFromAdf(descFull) : descFull

  const fields = {
    project: { key: m.projectKey },
    issuetype: { id: String(m.issueTypeId) },
    summary: m.summary.trim(),
  }
  if (descForCreate && !isEmptyAdf(descForCreate)) {
    fields.description = descForCreate
  }
  if (m.assigneeAccountId === '__UNASSIGNED__') {
    fields.assignee = null
  } else if (m.assigneeAccountId) {
    fields.assignee = { accountId: m.assigneeAccountId }
  }
  if (m.duedate) {
    fields.duedate = m.duedate
  }

  m.submitting = true
  m.error = null
  m.fieldErrors = {}
  if (m._descMount) {
    const ed = getEditorOnMount(m._descMount)
    if (ed) ed.setEditable(false)
  }
  render({ sections: ['modals'] })

  let createdKey = null
  try {
    const created = await createIssue(fields)
    createdKey = created?.key || null
    if (!createdKey) throw new Error('생성된 이슈 키를 찾을 수 없습니다.')

    // 이미지 첨부 업로드 + 설명 업데이트 — 일부 실패도 토스트로 부분 보고
    const attachErrors = []
    if (hasPending) {
      const idMap = {}
      for (const pendingId of pendingIds) {
        const entry = m._pendingImages?.[pendingId]
        if (!entry?.file) continue
        try {
          const uploaded = await uploadIssueAttachment(createdKey, entry.file)
          if (uploaded?.id) idMap[pendingId] = String(uploaded.id)
        } catch (e) {
          console.error('첨부 업로드 실패:', e)
          attachErrors.push(`${entry.filename}: ${formatJiraError(e)}`)
        }
      }
      // 업로드된 항목만 id 치환, 실패한 mediaSingle은 제거
      let descFinal = replacePendingMediaIds(descFull, idMap)
      descFinal = stripPendingMediaFromAdf(descFinal)
      if (descFinal && !isEmptyAdf(descFinal)) {
        try {
          await updateIssueDescription(createdKey, descFinal)
        } catch (e) {
          console.error('설명 업데이트 실패:', e)
          attachErrors.push(`설명 업데이트: ${formatJiraError(e)}`)
        }
      }
    }

    // 이슈 링크 추가 — 각 행의 모든 targetKeys에 대해 호출
    // 한 링크가 실패해도 다른 링크는 계속 시도하고 토스트로 부분 실패 보고
    const linkErrors = []
    for (const link of (m.links || [])) {
      const keys = (link.targetKeys || []).map(k => String(k || '').trim().toUpperCase()).filter(Boolean)
      for (const target of keys) {
        // outward: (새 일감) → outwardIssue, 대상 → inwardIssue
        // inward:  (새 일감) → inwardIssue, 대상 → outwardIssue
        const inwardKey = link.direction === 'outward' ? target : createdKey
        const outwardKey = link.direction === 'outward' ? createdKey : target
        try {
          await createIssueLink(link.typeName, inwardKey, outwardKey)
        } catch (e) {
          console.error('링크 추가 실패:', e)
          linkErrors.push(`${target}: ${formatJiraError(e)}`)
        }
      }
    }

    // 모달 닫고 목록 새로고침
    if (m._descMount) destroyInstanceOnMount(m._descMount)
    state.showCreateIssue = null
    render({ sections: ['modals'] })

    const partialMsgs = []
    if (attachErrors.length > 0) partialMsgs.push(`이미지 ${attachErrors.length}건 실패`)
    if (linkErrors.length > 0) partialMsgs.push(`링크 ${linkErrors.length}건 실패`)
    if (partialMsgs.length > 0) {
      showToast(`${createdKey} 생성됨. ${partialMsgs.join(', ')}`, '⚠')
    } else {
      showToast(`${createdKey} 일감을 생성했습니다.`, '✓')
    }
    // 백그라운드 새로고침 (할당됨/보고자에 새 이슈가 들어와야 보일 수 있음)
    refreshIssues().catch(() => {})
  } catch (err) {
    console.error('일감 생성 실패:', err)
    const cur = state.showCreateIssue
    if (cur) {
      cur.submitting = false
      cur.error = `생성 실패: ${formatJiraError(err)}`
      if (cur._descMount) {
        const ed = getEditorOnMount(cur._descMount)
        if (ed) ed.setEditable(true)
      }
    }
    render({ sections: ['modals'] })
    showToast(`일감 생성 실패: ${formatJiraError(err)}`, '⚠')
  }
}
