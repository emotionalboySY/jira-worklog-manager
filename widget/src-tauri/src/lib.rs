// Jira 업무 기록 위젯 — Rust 엔트리.
// - 시스템 트레이(보이기/숨기기/종료)
// - 로컬 루프백 OAuth 콜백 서버(데스크톱 3LO 로그인)
// - http / store 플러그인(외부 API 호출 CORS 우회 + 토큰 영속)
use std::io::{Read, Write};
use std::net::TcpListener;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

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
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        // 창 위치/크기 자동 저장·복원(main만 — 다이얼로그(finish/swap)는 중앙 유지 위해 제외)
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .skip_initial_state("finish")
                .skip_initial_state("swap")
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
        .invoke_handler(tauri::generate_handler![start_oauth_listener, open_in_chrome])
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
            let quit_i = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &hide_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Jira 업무 기록 위젯")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
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
