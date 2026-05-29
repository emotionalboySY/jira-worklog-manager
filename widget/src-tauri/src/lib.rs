// DK 워크로그 위젯 — Rust 엔트리.
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

// 고정 포트(43117)로 로컬 루프백 서버를 띄워 OAuth 콜백(code/state)을 한 번 받는다.
// Atlassian 개발자 콘솔에 redirect_uri = http://localhost:43117/callback 등록 필요.
// 콜백 수신 시 쿼리스트링을 'oauth://callback' 이벤트로 프론트엔드에 전달한다.
#[tauri::command]
async fn start_oauth_listener(app: tauri::AppHandle) -> Result<u16, String> {
    let port: u16 = 43117;
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
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
            let _ = app.emit("oauth-callback", query);
        }
    });
    Ok(port)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![start_oauth_listener])
        .setup(|app| {
            let show_i = MenuItem::with_id(app, "show", "위젯 보이기", true, None::<&str>)?;
            let hide_i = MenuItem::with_id(app, "hide", "숨기기", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &hide_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("DK 워크로그 위젯")
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
