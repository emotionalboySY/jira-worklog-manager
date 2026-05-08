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

## 환경 변수 (Vercel)
- `VITE_ATLASSIAN_CLIENT_ID`: 프론트엔드 번들에 포함되는 OAuth 클라이언트 ID (공개 가능)
- `ATLASSIAN_CLIENT_SECRET`: 서버 전용 클라이언트 시크릿 (절대 클라이언트 노출 금지)
- `ATLASSIAN_CLIENT_ID` (선택): 서버 전용 별칭. 미설정 시 `VITE_ATLASSIAN_CLIENT_ID` 사용
- `ALLOWED_ORIGINS` (선택, 권장): 쉼표 구분된 화이트리스트. 예: `https://your-app.vercel.app,http://localhost:5173`. 미설정 시 동일 호스트 origin만 허용
