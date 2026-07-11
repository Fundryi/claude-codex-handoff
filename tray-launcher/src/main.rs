//! Thin native tray and lifecycle shell around the Node viewer.

#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

#[path = "../icon_art.rs"]
mod icon_art;

use std::{
    env,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use notify_rust::Notification;
use tao::{
    event::{Event, StartCause},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
};
use tray_icon::{
    Icon, TrayIcon, TrayIconBuilder,
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const VIEWER_ID: &str = "codex-live-viewer";

#[derive(Debug)]
enum UserEvent {
    Menu(MenuEvent),
    Completion(String),
}

#[derive(Debug, Eq, PartialEq)]
enum ViewerProbe {
    Viewer,
    Closed,
    Other,
}

struct ViewerProcess {
    child: Option<Child>,
    script: Option<PathBuf>,
    last_exit: Option<String>,
}

impl ViewerProcess {
    fn ensure_running(port: u16) -> Result<Self, String> {
        match probe_viewer(port) {
            ViewerProbe::Viewer => {
                println!("[OK] Existing viewer found on port {port}; leaving it untouched.");
                return Ok(Self {
                    child: None,
                    script: None,
                    last_exit: None,
                });
            }
            ViewerProbe::Other => {
                return Err(format!(
                    "Port {port} is already used by another application. Set CODEX_VIEWER_PORT to a free port."
                ));
            }
            ViewerProbe::Closed => {}
        }

        Self::start_script(port, find_viewer_script()?)
    }

    fn start_script(port: u16, script: PathBuf) -> Result<Self, String> {
        let mut command = Command::new("node");
        command
            .arg(&script)
            .arg("serve")
            .env("CODEX_VIEWER_PORT", port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        #[cfg(target_os = "windows")]
        command.creation_flags(CREATE_NO_WINDOW);

        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start Node viewer: {error}"))?;

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if probe_viewer(port) == ViewerProbe::Viewer {
                println!(
                    "[OK] Node viewer started on port {port} (pid {}).",
                    child.id()
                );
                return Ok(Self {
                    child: Some(child),
                    script: Some(script),
                    last_exit: None,
                });
            }
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("Node viewer exited during startup: {status}"));
            }
            thread::sleep(Duration::from_millis(100));
        }

        let _ = child.kill();
        let _ = child.wait();
        Err("Node viewer did not become reachable within 5 seconds".into())
    }

    fn stop_owned(&mut self) {
        if let Some(mut child) = self.child.take() {
            println!("[i] Stopping Node viewer pid {}.", child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn poll_running(&mut self, port: u16) -> bool {
        let Some(child) = self.child.as_mut() else {
            return probe_viewer(port) == ViewerProbe::Viewer;
        };

        match child.try_wait() {
            Ok(None) => true,
            Ok(Some(status)) => {
                eprintln!("[X] Node viewer exited unexpectedly: {status}");
                self.last_exit = Some(status.to_string());
                self.child = None;
                false
            }
            Err(error) => {
                eprintln!("[X] Could not inspect Node viewer process: {error}");
                self.last_exit = Some(format!("process check failed: {error}"));
                self.child = None;
                false
            }
        }
    }

    fn restart(&mut self, port: u16) -> Result<(), String> {
        let owned = self.child.is_some() || self.script.is_some();
        if !owned && probe_viewer(port) == ViewerProbe::Viewer {
            return Err("The viewer on this port was not started by this tray instance".into());
        }
        let script = self.script.clone().map_or_else(find_viewer_script, Ok)?;
        self.stop_owned();
        *self = Self::start_script(port, script)?;
        Ok(())
    }

    fn take_exit_reason(&mut self) -> Option<String> {
        self.last_exit.take()
    }
}

impl Drop for ViewerProcess {
    fn drop(&mut self) {
        self.stop_owned();
    }
}

fn main() {
    let viewer_port = env_port("CODEX_VIEWER_PORT", 8377);
    let tray_port = env_port("CODEX_VIEWER_TRAY_PORT", viewer_port.saturating_add(1));
    let url = format!("http://localhost:{viewer_port}");

    let _single_instance = match TcpListener::bind(("127.0.0.1", tray_port)) {
        Ok(listener) => listener,
        Err(_) => {
            if probe_viewer(viewer_port) == ViewerProbe::Viewer {
                let _ = open::that(&url);
            } else {
                show_error(&format!(
                    "Tray lock port {tray_port} is already in use, but the viewer is stopped. Use Restart viewer from the existing tray menu."
                ));
            }
            return;
        }
    };

    let mut viewer = match ViewerProcess::ensure_running(viewer_port) {
        Ok(viewer) => viewer,
        Err(error) => {
            fail(&error);
        }
    };

    if env::var_os("CODEX_TRAY_NO_OPEN").is_none() {
        let _ = open::that(&url);
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    if env::var("CODEX_VIEWER_NOTIFICATIONS").as_deref() != Ok("0") {
        let notification_proxy = proxy.clone();
        thread::spawn(move || notification_loop(viewer_port, notification_proxy));
    }
    let menu_proxy = proxy.clone();
    MenuEvent::set_event_handler(Some(move |event| {
        let _ = menu_proxy.send_event(UserEvent::Menu(event));
    }));

    let status_item = MenuItem::new("Status: Running", false, None);
    let open_item = MenuItem::new("Open viewer", true, None);
    let restart_item = MenuItem::new("Restart viewer", true, None);
    let exit_item = MenuItem::new("Exit", true, None);
    let open_id = open_item.id().clone();
    let restart_id = restart_item.id().clone();
    let exit_id = exit_item.id().clone();
    let menu = Menu::new();
    if let Err(error) = menu.append_items(&[
        &status_item,
        &open_item,
        &restart_item,
        &PredefinedMenuItem::separator(),
        &exit_item,
    ]) {
        fail(&format!("Could not construct tray menu: {error}"));
    }

    let mut tray: Option<TrayIcon> = None;
    let mut viewer_running = true;
    println!("[OK] Codex Live Viewer tray running. URL: {url}");

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_secs(1));

        match event {
            Event::NewEvents(StartCause::Init) => {
                match TrayIconBuilder::new()
                    .with_menu(Box::new(menu.clone()))
                    .with_tooltip(format!("Codex Live Viewer ({url})"))
                    .with_icon(viewer_icon())
                    .build()
                {
                    Ok(icon) => {
                        tray = Some(icon);
                        update_tray_state(
                            tray.as_ref(),
                            &status_item,
                            &open_item,
                            &url,
                            viewer_running,
                        );
                    }
                    Err(error) => {
                        show_error(&format!("Could not create tray icon: {error}"));
                        viewer.stop_owned();
                        *control_flow = ControlFlow::Exit;
                    }
                }
            }
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => {
                let running = viewer.poll_running(viewer_port);
                if running != viewer_running {
                    viewer_running = running;
                    update_tray_state(
                        tray.as_ref(),
                        &status_item,
                        &open_item,
                        &url,
                        viewer_running,
                    );
                    if !viewer_running {
                        show_viewer_stopped(viewer.take_exit_reason().as_deref());
                    }
                }
            }
            Event::UserEvent(UserEvent::Menu(event)) if event.id == open_id => {
                if viewer.poll_running(viewer_port) {
                    let _ = open::that(&url);
                } else {
                    show_error("The viewer is stopped. Choose Restart viewer from the tray menu.");
                }
            }
            Event::UserEvent(UserEvent::Menu(event)) if event.id == restart_id => {
                match viewer.restart(viewer_port) {
                    Ok(()) => {
                        viewer_running = true;
                        update_tray_state(tray.as_ref(), &status_item, &open_item, &url, true);
                        show_viewer_restarted();
                    }
                    Err(error) => {
                        viewer_running = false;
                        update_tray_state(tray.as_ref(), &status_item, &open_item, &url, false);
                        show_error(&format!("Could not restart the viewer: {error}"));
                    }
                }
            }
            Event::UserEvent(UserEvent::Menu(event)) if event.id == exit_id => {
                viewer.stop_owned();
                tray.take();
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::Completion(title)) => {
                show_completion(&title);
            }
            _ => {}
        }
    });
}

fn env_port(name: &str, fallback: u16) -> u16 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

fn probe_viewer(port: u16) -> ViewerProbe {
    let address = format!("127.0.0.1:{port}")
        .parse()
        .expect("valid loopback address");
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(250)) {
        Ok(stream) => stream,
        Err(_) => return ViewerProbe::Closed,
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let request =
        format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return ViewerProbe::Other;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return ViewerProbe::Other;
    }
    if response.starts_with("HTTP/1.1 200")
        && response.contains(&format!("\"application\":\"{VIEWER_ID}\""))
    {
        ViewerProbe::Viewer
    } else {
        ViewerProbe::Other
    }
}

fn notification_loop(port: u16, proxy: EventLoopProxy<UserEvent>) {
    loop {
        if let Err(error) = listen_for_notifications(port, &proxy) {
            eprintln!("[i] Notification stream disconnected: {error}");
        }
        thread::sleep(Duration::from_secs(1));
    }
}

fn listen_for_notifications(port: u16, proxy: &EventLoopProxy<UserEvent>) -> std::io::Result<()> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    let request = format!(
        "GET /notifications HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n"
    );
    stream.write_all(request.as_bytes())?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "viewer closed the notification stream",
            ));
        }
        let Some(data) = line.strip_prefix("data: ") else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<serde_json::Value>(data.trim()) else {
            continue;
        };
        if event.get("type").and_then(|value| value.as_str()) != Some("complete") {
            continue;
        }
        let title = event
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("Codex task")
            .to_string();
        if proxy.send_event(UserEvent::Completion(title)).is_err() {
            return Ok(());
        }
    }
}

fn show_completion(title: &str) {
    if let Err(error) = Notification::new()
        .appname("Codex Live Viewer")
        .summary("Codex task complete")
        .body(title)
        .show()
    {
        eprintln!("[i] Could not show completion notification: {error}");
    }
}

fn show_viewer_stopped(reason: Option<&str>) {
    let body = reason.map_or_else(
        || "The background server exited. Use Restart viewer from the tray menu.".into(),
        |reason| {
            format!(
                "The background server exited ({reason}). Use Restart viewer from the tray menu."
            )
        },
    );
    let _ = Notification::new()
        .appname("Codex Live Viewer")
        .summary("Codex Live Viewer stopped")
        .body(&body)
        .show();
}

fn show_viewer_restarted() {
    let _ = Notification::new()
        .appname("Codex Live Viewer")
        .summary("Codex Live Viewer restarted")
        .body("The local dashboard is available again.")
        .show();
}

fn find_viewer_script() -> Result<PathBuf, String> {
    if let Some(explicit) = env::var_os("CODEX_VIEWER_JS") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!("CODEX_VIEWER_JS is not a file: {}", path.display()));
    }

    let mut candidates = vec![
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("codex-live-viewer.js"),
    ];

    if let Ok(exe) = env::current_exe()
        && let Some(dir) = exe.parent()
    {
        candidates.push(dir.join("codex-live-viewer.js"));
        if let Some(parent) = dir.parent() {
            candidates.push(parent.join("codex-live-viewer.js"));
            if let Some(grandparent) = parent.parent() {
                candidates.push(grandparent.join("codex-live-viewer.js"));
            }
        }
    }

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "Could not find codex-live-viewer.js; run from the repository root or set CODEX_VIEWER_JS"
                .into()
        })
}

fn viewer_icon() -> Icon {
    colored_viewer_icon([88, 166, 255])
}

fn viewer_stopped_icon() -> Icon {
    colored_viewer_icon([248, 81, 73])
}

fn colored_viewer_icon(color: [u8; 3]) -> Icon {
    const SIZE: u32 = 32;
    let rgba = icon_art::render_icon(SIZE, color);
    Icon::from_rgba(rgba, SIZE, SIZE).expect("valid generated tray icon")
}

fn update_tray_state(
    tray: Option<&TrayIcon>,
    status_item: &MenuItem,
    open_item: &MenuItem,
    url: &str,
    running: bool,
) {
    status_item.set_text(if running {
        "Status: Running"
    } else {
        "Status: Stopped"
    });
    open_item.set_enabled(running);

    if let Some(tray) = tray {
        let tooltip = if running {
            format!("Codex Live Viewer ({url})")
        } else {
            "Codex Live Viewer stopped — use Restart viewer".into()
        };
        let _ = tray.set_tooltip(Some(tooltip));
        let _ = tray.set_icon(Some(if running {
            viewer_icon()
        } else {
            viewer_stopped_icon()
        }));
    }
}

fn fail(message: &str) -> ! {
    show_error(message);
    eprintln!("[X] {message}");
    std::process::exit(1)
}

#[cfg(target_os = "windows")]
fn show_error(message: &str) {
    let title: Vec<u16> = "Codex Live Viewer\0".encode_utf16().collect();
    let text: Vec<u16> = format!("{message}\0").encode_utf16().collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn show_error(message: &str) {
    eprintln!("Codex Live Viewer: {message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_when_owned_node_child_exits() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve test port");
        let port = listener.local_addr().expect("test address").port();
        drop(listener);
        let child = Command::new("node")
            .args(["-e", "process.exit(7)"])
            .spawn()
            .expect("Node is available for the tray launcher");
        let mut viewer = ViewerProcess {
            child: Some(child),
            script: None,
            last_exit: None,
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut running = true;

        while Instant::now() < deadline && running {
            running = viewer.poll_running(port);
            thread::sleep(Duration::from_millis(20));
        }

        assert!(!running);
        assert!(viewer.child.is_none());
        assert!(viewer.take_exit_reason().is_some());
    }

    #[test]
    fn restarts_viewer_after_owned_child_exits() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve test port");
        let port = listener.local_addr().expect("test address").port();
        drop(listener);
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("codex-live-viewer.js");
        let mut viewer = ViewerProcess::start_script(port, script).expect("start test viewer");

        viewer
            .child
            .as_mut()
            .expect("owned child")
            .kill()
            .expect("kill test viewer");
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && viewer.poll_running(port) {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!viewer.poll_running(port));

        viewer.restart(port).expect("restart test viewer");
        assert_eq!(probe_viewer(port), ViewerProbe::Viewer);
        viewer.stop_owned();
        assert_eq!(probe_viewer(port), ViewerProbe::Closed);
    }
}
