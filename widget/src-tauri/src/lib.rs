// Jira 업무 기록 위젯 — Rust 엔트리.
// - 시스템 트레이(더블클릭으로 보이기·전면화 / 메뉴: 보이기·숨기기·설정·클릭 통과·종료)
// - 설정 창(별도 window) 생성
// - 클릭 통과(Rainmeter식 마우스 이벤트 무시) 토글
// - 로컬 루프백 OAuth 콜백 서버(데스크톱 3LO 로그인)
// - http / store 플러그인(외부 API 호출 CORS 우회 + 토큰 영속)
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

// 클릭 통과 상태 — 트레이 메뉴와 설정 창 양쪽에서 토글되므로 Rust가 단일 소유한다.
static CLICK_THROUGH: AtomicBool = AtomicBool::new(false);

// 트레이 메뉴의 '클릭 통과' 체크 항목 — 설정 창에서 바뀔 때 체크 표시를 맞추기 위해 보관.
struct TrayState {
    click_through_item: CheckMenuItem<tauri::Wry>,
}

// 위젯 본체를 화면에 띄우고 최상위로 끌어올린다(숨겨져 있으면 보이기 포함).
fn show_main_window(app: &tauri::AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    // '항상 위 고정'이 꺼져 있으면 다른 창에 가려져 있을 수 있다.
    // 최상위로 잠깐 올렸다 되돌리면 Z순서 맨 앞으로 이동한다(상태는 원복).
    if !w.is_always_on_top().unwrap_or(true) {
        let _ = w.set_always_on_top(true);
        let _ = w.set_always_on_top(false);
    }
    // 숨김 중엔 폴링을 건너뛰므로, 다시 보일 때 프론트가 즉시 갱신하도록 알린다.
    // (클릭 통과 중에는 포커스를 받지 못해 onFocusChanged로는 감지되지 않는다)
    let _ = app.emit("widget-shown", ());
}

// 클릭 통과 적용 — 본체 창에 반영하고 트레이 체크 표시·프론트 상태를 동기화한다.
fn apply_click_through(app: &tauri::AppHandle, enabled: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_ignore_cursor_events(enabled);
    }
    CLICK_THROUGH.store(enabled, Ordering::Relaxed);
    if let Some(state) = app.try_state::<TrayState>() {
        let _ = state.click_through_item.set_checked(enabled);
    }
    let _ = app.emit("click-through-changed", enabled);
}

#[tauri::command]
fn set_click_through(app: tauri::AppHandle, enabled: bool) {
    apply_click_through(&app, enabled);
}

#[tauri::command]
fn get_click_through() -> bool {
    CLICK_THROUGH.load(Ordering::Relaxed)
}

// 고정 포트(43117)로 로컬 루프백 서버를 띄워 OAuth 콜백(code/state)을 받는다.
// Atlassian 개발자 콘솔에 redirect_uri = http://localhost:43117/callback 등록 필요.
// 콜백 수신 시 쿼리스트링을 'oauth-callback' 이벤트로 프론트엔드에 전달한다.
//
// 리스너는 최초 호출에서 1회만 bind하고 앱 수명 동안 상주하며 accept 루프를 돈다.
// (이전: accept 1회 후 종료하는 스레드가 인증 중단 시 accept에 영원히 블록돼 포트를
//  점유 → 다음 로그인 시도에서 bind 실패 → 앱 재시작 전까지 재로그인 불가)
static OAUTH_LISTENER_STARTED: std::sync::Mutex<bool> = std::sync::Mutex::new(false);

#[tauri::command]
async fn start_oauth_listener(app: tauri::AppHandle) -> Result<u16, String> {
    let port: u16 = 43117;
    let mut started = OAUTH_LISTENER_STARTED
        .lock()
        .map_err(|e| e.to_string())?;
    if *started {
        // 이미 상주 중 — 재로그인 시도는 기존 리스너를 재사용
        return Ok(port);
    }
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    *started = true;
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            // 첫 줄: "GET /callback?code=...&state=... HTTP/1.1"
            let first_line = req.lines().next().unwrap_or("");
            let path = first_line.split_whitespace().nth(1).unwrap_or("");
            let query = path.splitn(2, '?').nth(1).unwrap_or("").to_string();
            let body = "<!doctype html><html><head><meta charset=\"utf-8\"><title>로그인 완료</title></head><body style=\"font-family:sans-serif;background:#1a1c24;color:#e8eaf0;text-align:center;padding-top:80px\"><h2>로그인 완료</h2><p>이 창을 닫고 위젯으로 돌아가세요.</p></body></html>";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.as_bytes().len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
            // 콜백 경로가 아닌 잡음 요청(파비콘 등)은 이벤트로 전달하지 않음
            if path.starts_with("/callback") {
                let _ = app.emit("oauth-callback", query);
            }
        }
    });
    Ok(port)
}

// '웹에서 열기' — 웹앱을 기본 브라우저가 아니라 Google Chrome으로 연다.
// Windows: 표준 설치 경로의 chrome.exe를 우선 시도하고, 못 찾으면 App Paths(레지스트리)에
// 등록된 'chrome'을 cmd start로 실행한다. Chrome 미설치 등으로 실패하면 에러를 반환해
// 프론트가 안내 메시지를 띄운다.
// cmd 경유 실행 특성상 임의 문자열 인자를 막기 위해 https URL만 허용한다.
#[tauri::command]
fn open_in_chrome(url: String) -> Result<(), String> {
    use std::process::Command;
    if !url.starts_with("https://") {
        return Err("https URL만 열 수 있습니다".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::path::PathBuf;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        // 표준 설치 경로 후보(64/32비트 시스템 설치 + 사용자 단위 설치)
        for base in [
            std::env::var("PROGRAMFILES").ok(),
            std::env::var("PROGRAMFILES(X86)").ok(),
            std::env::var("LOCALAPPDATA").ok(),
        ]
        .into_iter()
        .flatten()
        {
            let mut p = PathBuf::from(base);
            p.push(r"Google\Chrome\Application\chrome.exe");
            if p.exists() {
                return Command::new(&p)
                    .arg(&url)
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| e.to_string());
            }
        }
        // 경로를 못 찾으면 App Paths에 등록된 'chrome'을 start로 시도(콘솔 창은 숨김)
        return Command::new("cmd")
            .args(["/C", "start", "", "chrome", url.as_str()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "windows"))]
    {
        return Command::new("google-chrome")
            .arg(&url)
            .spawn()
            .or_else(|_| Command::new("chrome").arg(&url).spawn())
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 중복 실행 방지 — 두 번째 실행 시 새 프로세스를 띄우지 않고 기존 창을 보여준다.
        // (자동 시작 + 수동 실행으로 위젯이 2개 떠 트레이/폴링이 중복되는 것 방지)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        // 창 위치/크기 자동 저장·복원(main만 — 다이얼로그(finish/swap/settings)는 중앙 유지 위해 제외)
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .skip_initial_state("finish")
                .skip_initial_state("swap")
                .skip_initial_state("settings")
                .build(),
        )
        // Windows 로그인 시 자동 실행(레지스트리 Run 키). 토글은 JS API로 on/off.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // 자동 업데이트(서명 검증) + 설치 후 재시작.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            start_oauth_listener,
            open_in_chrome,
            set_click_through,
            get_click_through
        ])
        // 메인 창의 닫기(✕/Alt+F4)는 종료가 아니라 트레이로 숨김 — 상주 위젯.
        // 완전 종료는 트레이 메뉴 '종료'에서만.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let show_i = MenuItem::with_id(app, "show", "위젯 보이기", true, None::<&str>)?;
            let hide_i = MenuItem::with_id(app, "hide", "숨기기", true, None::<&str>)?;
            let settings_i = MenuItem::with_id(app, "settings", "설정", true, None::<&str>)?;
            // 클릭 통과 — 위젯이 마우스를 무시해 아래 창이 클릭을 받는다.
            // 켜면 위젯 자체를 클릭할 수 없으므로 해제 경로를 트레이 메뉴에 항상 둔다.
            let click_through_i = CheckMenuItem::with_id(
                app,
                "click-through",
                "클릭 통과",
                true,
                false,
                None::<&str>,
            )?;
            let quit_i = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show_i,
                    &hide_i,
                    &sep1,
                    &settings_i,
                    &click_through_i,
                    &sep2,
                    &quit_i,
                ],
            )?;
            app.manage(TrayState {
                click_through_item: click_through_i.clone(),
            });

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Jira 업무 기록 위젯")
                .menu(&menu)
                // 좌클릭은 메뉴 대신 클릭 이벤트로 받는다(더블클릭 감지용).
                .show_menu_on_left_click(false)
                // 트레이 아이콘 더블클릭 — 위젯을 전면으로, 숨겨져 있으면 보이기.
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "hide" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    // 창 생성은 본체(JS)에 맡긴다 — Windows에서 WebviewWindowBuilder를
                    // 이벤트 핸들러/동기 커맨드에서 호출하면 WebView2가 데드락한다.
                    // (finish/swap 다이얼로그와 같은 경로: 코어가 IPC로 처리)
                    "settings" => {
                        let _ = app.emit("open-settings", ());
                    }
                    "click-through" => {
                        // CheckMenuItem은 클릭 시 체크 상태가 이미 토글돼 있다 —
                        // 그 값을 그대로 읽어 적용(실패 시 내부 상태 기준으로 반전).
                        let next = app
                            .try_state::<TrayState>()
                            .and_then(|s| s.click_through_item.is_checked().ok())
                            .unwrap_or(!CLICK_THROUGH.load(Ordering::Relaxed));
                        apply_click_through(app, next);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // 실시간 마그넷 스냅 + 비율 고정 리사이즈(Windows 창 메시지 후킹)
            #[cfg(target_os = "windows")]
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(hwnd) = win.hwnd() {
                    win_behavior::install(hwnd.0 as isize);
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ===== Windows 창 메시지 후킹 =====
// 드래그는 OS가 입력을 처리하는 도중에 일어난다. 사후 이벤트(Moved)에서 setPosition으로
// 되돌리면 OS 입력과 충돌해 떨린다. 그래서 입력 처리 파이프라인 안에서 좌표를 미리 보정한다
// → OS가 보정된 값으로만 그리므로 실시간이고 떨림이 없다.
// (높이 고정·좌우만 리사이즈는 tauri.conf.json의 minHeight=maxHeight로 OS가 처리한다.)
#[cfg(target_os = "windows")]
mod win_behavior {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        SET_WINDOW_POS_FLAGS, SWP_NOMOVE, WINDOWPOS, WM_WINDOWPOSCHANGING,
    };

    const SNAP: i32 = 24; // 가장자리 흡착 임계값(물리 px)

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        match msg {
            // 이동 중 좌표를 모니터 작업영역 가장자리에 흡착(실시간 마그넷)
            WM_WINDOWPOSCHANGING => {
                let wp = &mut *(lparam.0 as *mut WINDOWPOS);
                if wp.flags & SWP_NOMOVE == SET_WINDOW_POS_FLAGS(0) {
                    let mut mi = MONITORINFO {
                        cbSize: core::mem::size_of::<MONITORINFO>() as u32,
                        ..Default::default()
                    };
                    let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                    if GetMonitorInfoW(hmon, &mut mi).as_bool() {
                        let work = mi.rcWork;
                        if (wp.x - work.left).abs() <= SNAP {
                            wp.x = work.left;
                        } else if ((wp.x + wp.cx) - work.right).abs() <= SNAP {
                            wp.x = work.right - wp.cx;
                        }
                        if (wp.y - work.top).abs() <= SNAP {
                            wp.y = work.top;
                        } else if ((wp.y + wp.cy) - work.bottom).abs() <= SNAP {
                            wp.y = work.bottom - wp.cy;
                        }
                    }
                }
                DefSubclassProc(hwnd, msg, wparam, lparam)
            }
            _ => DefSubclassProc(hwnd, msg, wparam, lparam),
        }
    }

    // main 창 HWND에 서브클래스 설치(앱 수명 동안 유지).
    pub fn install(hwnd_raw: isize) {
        unsafe {
            let _ = SetWindowSubclass(HWND(hwnd_raw as *mut _), Some(subclass_proc), 1, 0);
        }
    }
}
