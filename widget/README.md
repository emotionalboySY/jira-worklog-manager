# 워크로그 데스크톱 위젯 (JiraWorklogWidget)

Jira 작업 세션(타이머)을 데스크톱에 상주 표시·제어하는 미니 위젯.
웹앱(Vercel)과 **공유 백엔드**(`/api/sessions` + Upstash Redis)로 진행 중 세션을 폴링 동기화한다.
Tauri v2 + Vite Vanilla JS.

## 구조

- `src/main.js` — 본체 창: 세션 표시(1초 경과시계), 중단/재개/종료/교체/시작시각 조정, 설정 패널(투명도·자동시작·업데이트), 폴링(3s/10s + 실패 시 지수 백오프)
- `src/finish.js` — 종료 다이얼로그: 제출 직전 세션 재검증 → worklog 조각 기록(실패 시 이어서 재시도, 중복 방지) → 세션 제거
- `src/swap.js` — 일감 교체/지정 다이얼로그
- `src/api.js` — 백엔드(세션)·Jira API 호출 (http 플러그인으로 CORS 우회)
- `src/auth.js` — 데스크톱 OAuth(3LO, loopback 43117), 토큰은 plugin-store(`auth.json`)
- `src/shared.js` — 창 공통 헬퍼 (escapeHtml/fmtMinutes/NO_ISSUE_KEY)
- `../../lib/worklogLogic.js` — **웹앱과 공유**하는 점심(11:30~12:30)·자정 분할 worklog 로직
- `src-tauri/src/lib.rs` — 트레이, OAuth 루프백 리스너(상주), 마그넷 스냅(Windows 창 후킹), single-instance

## 개발

```sh
cd widget
npm install
npm run tauri dev
```

- `widget/.env`에 `VITE_ATLASSIAN_CLIENT_ID` 필요 (공개 가능 값)
- Atlassian 콘솔에 redirect_uri `http://localhost:43117/callback` 등록돼 있어야 로그인 동작

## 릴리스 절차

1. 버전 올리기: `package.json` + `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml`
2. 커밋/푸시
3. 서명 빌드 (PowerShell):
   ```powershell
   cd widget
   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.dk-widget-updater.key" -Raw
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
   npm run tauri build
   ```
   - 산출물: `src-tauri/target/release/bundle/nsis/JiraWorklogWidget_X.Y.Z_x64-setup.exe` + `.sig`
   - **번들 타깃은 NSIS만** (MSI/WiX는 한글 productName 이슈로 사용 안 함)
   - 첫 빌드에서 `os error 5` 나면 Defender 일시 잠금 — 그냥 재빌드하면 성공
4. `latest.json` 작성: version / notes / pub_date / platforms."windows-x86_64"의 signature(`.sig` 파일 내용)와 url(`releases/download/vX.Y.Z/JiraWorklogWidget_X.Y.Z_x64-setup.exe`)
5. 릴리스 생성 (소스 repo는 private — installer는 **별도 public repo**에 올림):
   ```sh
   gh release create vX.Y.Z --repo emotionalboySY/jira-worklog-widget-releases \
     --title "vX.Y.Z" --notes "..." <setup.exe> <latest.json>
   ```
6. updater 엔드포인트 확인: `https://github.com/emotionalboySY/jira-worklog-widget-releases/releases/latest/download/latest.json` 이 새 버전을 반환하는지

- 서명키: `%USERPROFILE%\.dk-widget-updater.key` (+`.pub`, repo 밖 보관)
- 기존 설치본은 시작 시 자동 업데이트 확인으로 새 버전을 안내받는다
