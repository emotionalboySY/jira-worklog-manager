// 위젯 설정.
// clientId는 widget/.env 의 VITE_ATLASSIAN_CLIENT_ID 에서 읽는다(공개값 — 웹앱과 동일).
// apiBase는 배포된 웹앱(서버리스 함수 호스트). redirectUri는 Atlassian 콘솔에 등록한 루프백 주소.
export const CONFIG = {
  clientId: import.meta.env.VITE_ATLASSIAN_CLIENT_ID || '',
  apiBase: 'https://jira-worklog-manager.vercel.app',
  redirectUri: 'http://localhost:43117/callback',
  scopes: 'read:jira-work write:jira-work read:jira-user offline_access',
}
