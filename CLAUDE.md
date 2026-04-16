# Jira 작업 로그 매니저

## 기술 스택
- Vite + Vanilla JS (프론트엔드)
- Vercel Serverless Functions (API 프록시, OAuth)
- Atlassian OAuth 2.0 (3LO) 인증
- master 브랜치 push → Vercel 자동 배포

## 작업 규칙
- 소요 시간은 항상 한글 단위 (예: 3시간 30분), hm 형태 사용 금지
- 코드 수정 후 git push하면 Vercel이 자동 배포, 사용자가 Chrome에서 실제 URL로 테스트
- git author: emotionalboySY <gs_k_bear17@naver.com>

## TODO (다음 작업)
- [ ] 이슈 목록에서 이슈 클릭 시 새 탭으로 Jira 이슈 페이지 열기 (`https://{siteName}.atlassian.net/browse/{issueKey}`)
- [ ] 요약 탭 일별 업무 시간 차트에서 날짜 클릭 시 해당 날짜의 작업 로그 기록 탭으로 이동
