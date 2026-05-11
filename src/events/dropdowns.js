// 이슈 행/상세 모달의 드롭다운: 담당자, 이슈 유형, 상태 전이.
// 각 드롭다운은 stale-while-revalidate로 즉시 표시 + 백그라운드 fetch.
import { state, CLOSED_CATEGORY } from '../state.js'
import {
  fetchAssignableUsers,
  updateIssueAssignee,
  updateIssueType,
  transitionIssue,
  fetchIssueStatus,
  invalidateTransitionsCache,
  getCachedAssignableUsers,
  setCachedAssignableUsers,
} from '../jira.js'
import { saveIssuesCache, removeFavorite } from '../storage.js'
import { showToast } from '../ui.js'
import { formatJiraError } from '../utils.js'
import { renderAssigneeDropdownListContents } from '../views/modals.js'
import { render } from '../render.js'

// 담당자 드롭다운 닫기
export function closeAssigneeDropdown({ skipRender = false } = {}) {
  state.assigneeDropdown = null
  if (!skipRender) render({ sections: ['modals'] })
}

// 리스트 영역만 부분 재렌더. 전체 render()를 피해 검색 input의 IME 조합 유지.
export function refreshAssigneeDropdownList() {
  const dd = state.assigneeDropdown
  if (!dd) return
  const listEl = document.getElementById('assignee-dd-list')
  if (listEl) listEl.innerHTML = renderAssigneeDropdownListContents(dd)
}

// 드롭다운 오픈 시 최초 1회 전체 사용자 조회. 이후 검색은 로컬 필터.
// 캐시가 있으면 호출 전에 이미 즉시 표시 — 여기서는 백그라운드 fetch로 신선화.
export async function loadAssignableUsers(issueKey) {
  const hadCache = !!getCachedAssignableUsers(issueKey)
  try {
    const users = await fetchAssignableUsers(issueKey)
    setCachedAssignableUsers(issueKey, users)
    if (!state.assigneeDropdown || state.assigneeDropdown.issueKey !== issueKey) return
    state.assigneeDropdown.allUsers = users
    state.assigneeDropdown.loading = false
    refreshAssigneeDropdownList()
  } catch (err) {
    console.error('할당 가능한 사용자 조회 실패:', err)
    // 캐시로 이미 표시 중이면 사용자 흐름을 끊지 않음
    if (hadCache) return
    if (!state.assigneeDropdown || state.assigneeDropdown.issueKey !== issueKey) return
    state.assigneeDropdown.allUsers = []
    state.assigneeDropdown.loading = false
    refreshAssigneeDropdownList()
    showToast(`사용자 조회 실패: ${formatJiraError(err)}`, '⚠')
  }
}

// 담당자 변경 실행. 진행 중 스피너 → 성공 시 아바타 즉시 갱신 + 토스트
export async function applyAssigneeChange(issueKey, accountId, selectedUser) {
  state.assigneeUpdating.add(issueKey)
  render({ sections: ['content', 'modals'] })
  try {
    await updateIssueAssignee(issueKey, accountId)
    const newAssignee = !accountId
      ? null
      : (selectedUser ? {
          accountId: selectedUser.accountId,
          displayName: selectedUser.displayName,
          avatarUrl: selectedUser.avatarUrl,
        } : null)
    // realIssues에서 해당 이슈의 assignee 갱신
    for (const issue of state.realIssues) {
      if (issue.key !== issueKey) continue
      issue.assignee = newAssignee
      break
    }
    // 상세 모달이 같은 이슈를 보고 있으면 거기도 갱신
    if (state.issueDetailModal && state.issueDetailModal.key === issueKey && state.issueDetailModal.data) {
      state.issueDetailModal.data.assignee = newAssignee
    }
    showToast(accountId
      ? `담당자를 ${selectedUser?.displayName || ''}(으)로 변경했습니다.`
      : '담당자를 미할당으로 변경했습니다.', '✓')
  } catch (err) {
    console.error('담당자 변경 실패:', err)
    showToast(`담당자 변경 실패: ${formatJiraError(err)}`, '⚠')
  } finally {
    state.assigneeUpdating.delete(issueKey)
    render({ sections: ['content', 'modals'] })
  }
}

// 이슈 유형 변경 실행. 성공 시 realIssues + 상세 모달 동기 갱신.
export async function performTypeChange(issueKey, typeInfo) {
  state.typeUpdating.add(issueKey)
  render({ sections: ['content', 'modals'] })
  try {
    await updateIssueType(issueKey, typeInfo.id)
    // realIssues 갱신
    for (const arr of [state.realIssues, state.searchResults]) {
      if (!Array.isArray(arr)) continue
      const idx = arr.findIndex(i => i.key === issueKey)
      if (idx >= 0) {
        arr[idx] = { ...arr[idx], type: typeInfo.name, typeIconUrl: typeInfo.iconUrl || '' }
      }
    }
    try { saveIssuesCache(state.realIssues, state.realProjects) } catch {}
    // 상세 모달 갱신
    if (state.issueDetailModal && state.issueDetailModal.key === issueKey && state.issueDetailModal.data) {
      state.issueDetailModal.data.type = typeInfo.name
      state.issueDetailModal.data.typeIconUrl = typeInfo.iconUrl || ''
    }
    showToast(`유형을 '${typeInfo.name}'(으)로 변경했습니다.`, '✓')
  } catch (err) {
    console.error('유형 변경 실패:', err)
    showToast(`유형 변경 실패: ${formatJiraError(err)}`, '⚠')
  } finally {
    state.typeUpdating.delete(issueKey)
    render({ sections: ['content', 'modals'] })
  }
}

// ========== 상태 전이 실행 ==========
// 이슈별 독립 로딩: state.statusTransitioning에 키를 추가/제거.
// 여러 이슈의 전이가 동시에 진행돼도 각자 독립 스피너가 돌아감.
// fields=null이면 필드 없는 단순 전이, 객체면 해당 필드들을 함께 전송.
export async function performTransition(issueKey, transition, fields) {
  state.statusTransitioning.add(issueKey)
  // 해당 이슈의 상태 버튼만 스피너로 갱신 (상세 모달 안에서도 보일 수 있도록 modals도 재렌더)
  render({ sections: ['content', 'modals'] })
  try {
    await transitionIssue(issueKey, transition.id, fields)
    // 전이가 일어나면 가능한 다음 전이 목록이 바뀌므로 캐시 즉시 무효화
    invalidateTransitionsCache(issueKey)
    // 전이 후 실제 status 재조회 (워크플로우에 따라 전이의 to.name과 실제 이동값이 다를 수 있음)
    const latest = await fetchIssueStatus(issueKey)
    if (latest) {
      updateIssueStatusInState(issueKey, latest)
    } else {
      // 폴백: transition 정의대로 낙관적 업데이트
      updateIssueStatusInState(issueKey, {
        status: transition.to?.name || '',
        statusCategory: transition.to?.statusCategory?.key || 'new',
      })
    }
    showToast(`${issueKey} → ${transition.to?.name || transition.name}`, '✓')
  } catch (e) {
    console.error('상태 전이 실패:', e)
    showToast(`상태 변경 실패: ${formatJiraError(e)}`, '⚠')
  } finally {
    state.statusTransitioning.delete(issueKey)
    render({ sections: ['content', 'modals'] })
  }
}

// realIssues / searchResults에서 이슈의 status/statusCategory 갱신 + 캐시 동기화
// 완료(done) 카테고리로 들어온 이슈는 즐겨찾기에서도 자동 제거.
function updateIssueStatusInState(issueKey, { status, statusCategory }) {
  const apply = (arr) => {
    if (!Array.isArray(arr)) return
    const idx = arr.findIndex(i => i.key === issueKey)
    if (idx >= 0) {
      arr[idx] = { ...arr[idx], status, statusCategory }
    }
  }
  apply(state.realIssues)
  apply(state.searchResults)
  try { saveIssuesCache(state.realIssues, state.realProjects) } catch {}
  // 상세 모달이 같은 이슈면 즉시 동기화 (상세 모달도 상태 변경 진입점이 됨)
  if (state.issueDetailModal && state.issueDetailModal.key === issueKey && state.issueDetailModal.data) {
    state.issueDetailModal.data.status = status
    state.issueDetailModal.data.statusCategory = statusCategory
  }
  if (statusCategory === CLOSED_CATEGORY) {
    if (removeFavorite(issueKey)) {
      render({ sections: ['favorites'] })
    }
  }
}
