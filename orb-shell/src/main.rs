//! orb-shell — native companion of the dsh-orb DeepSeek Harness plugin.
//!
//! Recreates what DeepSeek Orb 0.1.7's Electron main process did for the floating ball:
//! a transparent, always-on-top WebView2 window running Orb's own renderer (served by the plugin from the
//! Harness Host), the window geometry (drag, dock, expand), the native context menu, the Computer Use overlay
//! guard (hidden from screenshots, click-through while the agent drives the mouse) and the observation frame.
//!
//! Protocol with the plugin (lib/host/shell.js): JSON lines. stdin: `hello`, `overlay-guard`,
//! `observation-frame`, `quit`; stdout: the matching `*-ack` messages.

#![windows_subsystem = "windows"]

mod geometry;
mod win;

use geometry::*;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::time::{Duration, Instant};
use tao::dpi::{PhysicalPosition, PhysicalSize};
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::windows::{WindowBuilderExtWindows, WindowExtWindows};
use tao::window::{Window, WindowBuilder};
use windows_sys::Win32::Foundation::HWND;
use wry::{PageLoadEvent, WebContext, WebView, WebViewBuilder};

#[derive(Debug)]
enum UserEvent {
    Host(Value),
    Ipc(String),
    PageLoaded(String),
    /// Debug only (DSH_ORB_DEBUG_NOHIDE): run %LOCALAPPDATA%dsh-orbeval.js in the floating page.
    Eval(String),
    HostClosed,
}

/// Bridge from the renderer: window.ipc.postMessage(JSON) and window.__orbBridgeReceive(reply).
const BRIDGE_PRELUDE: &str = r#"
window.__ORB_SHELL__ = { native: 'wry' };
(() => {
  const log = (level, text) => { try { const ipc = window.ipc || (window.parent && window.parent.ipc); ipc && ipc.postMessage(JSON.stringify({ type: 'log', level, text: String(text).slice(0, 2000), url: location.href })) } catch {} };
  window.addEventListener('error', (e) => log('error', (e.message || e) + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')));
  window.addEventListener('unhandledrejection', (e) => log('rejection', e.reason && (e.reason.stack || e.reason.message) || e.reason));
  if (window.top === window) setInterval(() => { for (const f of document.querySelectorAll('iframe')) { try { const t = f.contentDocument && f.contentDocument.body && f.contentDocument.body.innerText || ''; if (/Failed to load plugins/.test(t) && f.__orbLogged !== t) { f.__orbLogged = t; log('overlay-boot', t) } } catch (e) { } } }, 1000);
  for (const level of ['error', 'warn']) { const original = console[level]; console[level] = (...args) => { log(level, args.map((a) => a && a.stack || (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ')); original.apply(console, args) } }
})();
"#;

/// Append a line to %LOCALAPPDATA%\dsh-orb\orb-shell.log (diagnostics; rotated at 1 MiB).
fn log_line(text: &str) {
    let Ok(base) = std::env::var("LOCALAPPDATA") else { return };
    let dir = std::path::PathBuf::from(base).join("dsh-orb");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("orb-shell.log");
    if std::fs::metadata(&path).map_or(false, |m| m.len() > 1 << 20) {
        let _ = std::fs::rename(&path, dir.join("orb-shell.log.1"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let _ = writeln!(f, "{secs} {text}");
    }
}

struct Anim {
    start: Rect,
    end: Rect,
    t0: Instant,
    dur: f64,
    ease: fn(f64) -> f64,
    then: AnimThen,
}

enum AnimThen {
    None,
    /// snapToEdge: once off screen, become the 34x88 docked tab and answer `{ docked: side }`.
    SnapDone { side: Side, y: f64, bounds: Rect, reply: Option<u64> },
    /// unsnapDockedBall: answer `{ docked: undefined }`.
    Reply(u64),
}

struct Floating {
    window: Window,
    webview: WebView,
    direction: Option<Direction>,
    dock: Option<Dock>,
    anim: Option<Anim>,
    capture: u32,
    input: u32,
    click_through: bool,
    session_running: bool,
    text_editing: bool,
    panel: PanelSize,
    panel_file: Option<std::path::PathBuf>,
}

impl Floating {
    fn hwnd(&self) -> HWND {
        self.window.hwnd() as HWND
    }
    fn scale(&self) -> f64 {
        self.window.scale_factor()
    }
    fn bounds(&self) -> Rect {
        let r = win::window_rect(self.hwnd());
        let s = self.scale();
        Rect { x: r.x / s, y: r.y / s, width: r.width / s, height: r.height / s }
    }
    fn set_bounds(&self, r: Rect) {
        let s = self.scale();
        win::set_window_rect(self.hwnd(), Rect { x: r.x * s, y: r.y * s, width: r.width * s, height: r.height * s });
    }
    /// `screen.getDisplayNearestPoint(point)` in the renderer's DIP space.
    fn display_near(&self, p: Point) -> Display {
        let s = self.scale();
        let monitors = win::monitors();
        let dip = |r: Rect| Rect { x: r.x / s, y: r.y / s, width: r.width / s, height: r.height / s };
        let mut best: Option<(f64, Display)> = None;
        for (b, w) in monitors {
            let d = Display { bounds: dip(b), work_area: dip(w) };
            let dx = (p.x - d.bounds.x.max(p.x.min(d.bounds.x + d.bounds.width))).abs();
            let dy = (p.y - d.bounds.y.max(p.y.min(d.bounds.y + d.bounds.height))).abs();
            let dist = dx * dx + dy * dy;
            if best.as_ref().map_or(true, |(bd, _)| dist < *bd) {
                best = Some((dist, d));
            }
        }
        best.map(|(_, d)| d).unwrap_or(Display {
            bounds: Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 },
            work_area: Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1040.0 },
        })
    }
    fn cancel_anim(&mut self) {
        // Orb resolves a cancelled animation's promise; a pending reply still gets an answer.
        if let Some(anim) = self.anim.take() {
            match anim.then {
                AnimThen::SnapDone { reply: Some(id), .. } | AnimThen::Reply(id) => self.reply(id, json!({})),
                _ => {}
            }
        }
    }
    fn animate(&mut self, end: Rect, dur: f64, ease: fn(f64) -> f64, then: AnimThen) {
        self.cancel_anim();
        self.anim = Some(Anim { start: self.bounds(), end, t0: Instant::now(), dur, ease, then });
    }
    fn step_anim(&mut self) {
        let Some(anim) = &self.anim else { return };
        let t = (anim.t0.elapsed().as_secs_f64() * 1000.0 / anim.dur).min(1.0);
        let rect = lerp_rect(anim.start, anim.end, (anim.ease)(t));
        self.set_bounds(rect);
        if t < 1.0 {
            return;
        }
        let anim = self.anim.take().unwrap();
        match anim.then {
            AnimThen::None => {}
            AnimThen::Reply(id) => self.reply(id, json!({})),
            AnimThen::SnapDone { side, y, bounds, reply } => {
                let still = self.dock.map_or(false, |d| d.side == side);
                if still {
                    self.set_bounds(docked_tab_bounds(side, y, bounds));
                }
                if let Some(id) = reply {
                    let docked = if still { Some(side) } else { self.dock.map(|d| d.side) };
                    self.reply(id, serde_json::to_value(Docked { docked }).unwrap());
                }
            }
        }
    }
    fn current_ball_origin(&self, work_area: Rect) -> Point {
        let bounds = self.bounds();
        if let Some(d) = self.dock {
            return inside_ball_origin(d.side, d.y, &self.display_near(window_center(bounds)));
        }
        if is_collapsed(bounds) {
            return Point { x: bounds.x + 12.0, y: bounds.y + 12.0 };
        }
        ball_origin_from_window(bounds, self.direction.unwrap_or_else(|| expand_direction(Point { x: bounds.x, y: bounds.y }, work_area, self.panel)))
    }
    fn apply_docked_tab(&mut self, side: Side, ball_y: f64, bounds: Rect) -> Docked {
        let y = clamp_ball_y(ball_y, bounds);
        self.dock = Some(Dock { side, y });
        self.cancel_anim();
        self.set_bounds(docked_tab_bounds(side, y, bounds));
        Docked { docked: Some(side) }
    }
    /// `setFloatingExpanded`.
    fn set_expanded(&mut self, expanded: bool) -> ExpandState {
        let bounds = self.bounds();
        let display = self.display_near(window_center(bounds));
        let work_area = display.work_area;
        if expanded {
            let origin = self.current_ball_origin(work_area);
            self.dock = None;
            let (next, direction) = expanded_overlay_bounds(origin, work_area, clamp_panel(self.panel, work_area));
            self.direction = Some(direction);
            self.cancel_anim();
            self.set_bounds(next);
            return ExpandState { expanded: true, horizontal: direction.horizontal, vertical: direction.vertical, docked: None };
        }
        let direction = self.direction.unwrap_or_else(|| expand_direction(Point { x: bounds.x, y: bounds.y }, work_area, self.panel));
        if let Some(d) = self.dock {
            self.apply_docked_tab(d.side, d.y, display.bounds);
            return ExpandState { expanded: false, horizontal: direction.horizontal, vertical: direction.vertical, docked: Some(d.side) };
        }
        let origin = clamped_ball_origin(self.current_ball_origin(work_area), work_area);
        self.cancel_anim();
        self.set_bounds(collapsed_window_bounds(origin));
        ExpandState { expanded: false, horizontal: direction.horizontal, vertical: direction.vertical, docked: None }
    }
    /// `moveFloatingBall`.
    fn move_ball(&mut self, x: f64, y: f64, can_dock: bool) -> Docked {
        let origin = Point { x: round(x), y: round(y) };
        if !is_collapsed(self.bounds()) && self.dock.is_none() {
            let direction = self.direction.unwrap_or_else(|| expand_direction(origin, self.display_near(origin).work_area, self.panel));
            self.set_bounds(overlay_bounds_from_ball(origin, direction, self.panel));
            return Docked { docked: None };
        }
        if !can_dock {
            self.dock = None;
            self.cancel_anim();
            self.set_bounds(collapsed_window_bounds(origin));
            return Docked { docked: None };
        }
        let display = self.display_near(origin);
        if let Some(existing) = self.dock {
            if stays_docked(existing.side, origin.x, display.bounds) {
                return self.apply_docked_tab(existing.side, existing.y, display.bounds);
            }
        }
        self.dock = None;
        self.cancel_anim();
        self.set_bounds(collapsed_window_bounds(origin));
        Docked { docked: None }
    }
    /// `clampFloatingWindow`; returns None when the reply follows an animation.
    fn clamp_window(&mut self, can_dock: bool, reply: u64) -> Option<Docked> {
        let bounds = self.bounds();
        let display = self.display_near(window_center(bounds));
        if let Some(d) = self.dock {
            return Some(self.apply_docked_tab(d.side, d.y, display.bounds));
        }
        if is_collapsed(bounds) {
            let origin = Point { x: bounds.x + 12.0, y: bounds.y + 12.0 };
            if can_dock {
                if let Some(side) = dock_side_for_ball_origin(origin, display.bounds) {
                    // snapToEdge
                    let y = clamp_ball_y(origin.y, display.bounds);
                    self.dock = Some(Dock { side, y });
                    let end = collapsed_window_bounds(off_screen_ball_origin(side, y, display.bounds));
                    self.animate(end, 250.0, ease_in_out_cubic, AnimThen::SnapDone { side, y, bounds: display.bounds, reply: Some(reply) });
                    return None;
                }
            }
            self.set_bounds(collapsed_window_bounds(clamped_ball_origin(origin, display.work_area)));
            return Some(Docked { docked: None });
        }
        self.set_expanded(true);
        Some(Docked { docked: None })
    }
    /// `unsnapDockedBall`; returns None when the reply follows the slide-in animation.
    fn unsnap(&mut self, reply: u64) -> Option<Docked> {
        let Some(d) = self.dock else { return Some(Docked { docked: None }) };
        let display = self.display_near(window_center(self.bounds()));
        let start = off_screen_ball_origin(d.side, d.y, display.bounds);
        let end = inside_ball_origin(d.side, d.y, &display);
        self.dock = None;
        self.cancel_anim();
        self.set_bounds(collapsed_window_bounds(start));
        self.animate(collapsed_window_bounds(end), 300.0, ease_out_cubic, AnimThen::Reply(reply));
        None
    }
    /// dsh-orb addition: resize the expanded panel, keeping the ball where it is; remembered per profile.
    fn resize_panel(&mut self, width: f64, height: f64) -> PanelSize {
        let bounds = self.bounds();
        let work_area = self.display_near(window_center(bounds)).work_area;
        self.panel = clamp_panel(PanelSize { width, height }, work_area);
        if !is_collapsed(bounds) && self.dock.is_none() {
            let direction = self.direction.unwrap_or_else(|| expand_direction(Point { x: bounds.x, y: bounds.y }, work_area, self.panel));
            let ball = ball_origin_from_window(bounds, direction);
            self.cancel_anim();
            self.set_bounds(overlay_bounds_from_ball(ball, direction, self.panel));
        }
        if let Some(file) = &self.panel_file {
            let _ = std::fs::write(file, json!({ "width": self.panel.width, "height": self.panel.height }).to_string());
        }
        self.panel
    }
    /// `applyFloatingOverlayGuard` + `syncOverlayGuard` (Windows branch).
    fn overlay_guard(&mut self, mode: &str, begin: bool) {
        let counter = if mode == "input" { &mut self.input } else { &mut self.capture };
        *counter = if begin { *counter + 1 } else { counter.saturating_sub(1) };
        win::exclude_from_capture(self.hwnd(), self.capture > 0 || self.input > 0);
        let click_through = self.input > 0;
        if self.click_through != click_through {
            self.click_through = click_through;
            let _ = self.window.set_ignore_cursor_events(click_through);
        }
    }
    fn reset_overlay_guard(&mut self) {
        self.capture = 0;
        self.input = 0;
        self.click_through = false;
        win::exclude_from_capture(self.hwnd(), false);
        let _ = self.window.set_ignore_cursor_events(false);
    }
    fn reply(&self, id: u64, value: Value) {
        let msg = json!({ "type": "reply", "id": id, "value": value });
        let _ = self.webview.evaluate_script(&format!("window.__orbBridgeReceive && window.__orbBridgeReceive({msg})"));
    }
    fn reply_error(&self, id: u64, error: &str) {
        let msg = json!({ "type": "reply", "id": id, "error": error });
        let _ = self.webview.evaluate_script(&format!("window.__orbBridgeReceive && window.__orbBridgeReceive({msg})"));
    }
    fn emit(&self, channel: &str, payload: Value) {
        let msg = json!({ "type": "event", "channel": channel, "payload": payload });
        let _ = self.webview.evaluate_script(&format!("window.__orbBridgeReceive && window.__orbBridgeReceive({msg})"));
    }
}

struct Frame {
    window: Window,
    webview: WebView,
}

fn send_host(message: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{message}");
    let _ = out.flush();
}

fn main() {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    spawn_stdin_reader(proxy.clone());
    if std::env::var("DSH_ORB_DEBUG_NOHIDE").is_ok() {
        let eval_proxy = proxy.clone();
        std::thread::spawn(move || {
            let Ok(base) = std::env::var("LOCALAPPDATA") else { return };
            let path = std::path::PathBuf::from(base).join("dsh-orb").join("eval.js");
            loop {
                std::thread::sleep(Duration::from_millis(700));
                if let Ok(code) = std::fs::read_to_string(&path) {
                    let _ = std::fs::remove_file(&path);
                    let _ = eval_proxy.send_event(UserEvent::Eval(code));
                }
            }
        });
    }

    // The plugin sends `hello` first; wait for it before creating windows.
    let hello = loop {
        match wait_hello() {
            Some(v) => break v,
            None => return,
        }
    };
    let launch_url = hello["launchUrl"].as_str().unwrap_or_default().to_string();
    let base = launch_url.split('?').next().unwrap_or_default().trim_end_matches('/').to_string();
    let page_url = format!("{base}{}", hello["page"].as_str().unwrap_or("/.dsh/orb/floating.html"));
    let frame_url = format!("{base}/.dsh/orb/observation-frame.html");

    let data_dir = std::env::var("LOCALAPPDATA").map(|d| std::path::PathBuf::from(d).join("dsh-orb").join("webview")).ok();
    let mut web_context = WebContext::new(data_dir);

    // Start where Orb's createFloatingWindow started: the collapsed ball at the default origin (primary display).
    let window = WindowBuilder::new()
        .with_title("dsh-orb")
        .with_decorations(false)
        .with_transparent(true)
        .with_always_on_top(true)
        .with_resizable(false)
        .with_visible(false)
        .with_focused(false)
        .with_skip_taskbar(true)
        .with_undecorated_shadow(false)
        .with_inner_size(PhysicalSize::new(96u32, 96u32))
        .build(&event_loop)
        .expect("floating window");

    let ipc_proxy = proxy.clone();
    let load_proxy = proxy.clone();
    let webview = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_transparent(true)
        .with_background_color((0, 0, 0, 0))
        .with_initialization_script_for_main_only(BRIDGE_PRELUDE, false)
        .with_initialization_script_for_main_only(if std::env::var("DSH_ORB_DEBUG_NOHIDE").is_ok() { "window.__DSH_ORB_AUTOHIDE__ = { dockAutoHide: false, autoCollapseMs: 3600000 };" } else { "" }, true)
        .with_ipc_handler(move |req| {
            let _ = ipc_proxy.send_event(UserEvent::Ipc(req.body().clone()));
        })
        .with_on_page_load_handler(move |event, url| {
            if matches!(event, PageLoadEvent::Finished) {
                let _ = load_proxy.send_event(UserEvent::PageLoaded(url));
            }
        })
        .with_url(&launch_url)
        .build(&window)
        .expect("floating webview");

    let mut floating = Floating {
        window,
        webview,
        direction: None,
        dock: None,
        anim: None,
        capture: 0,
        input: 0,
        click_through: false,
        session_running: false,
        text_editing: false,
        panel: DEFAULT_PANEL,
        panel_file: hello["profile"].as_str().map(|p| std::path::PathBuf::from(p).join("orb-panel-size.json")),
    };
    if let Some(saved) = floating.panel_file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        if let (Some(w), Some(h)) = (saved["width"].as_f64(), saved["height"].as_f64()) {
            floating.panel = PanelSize { width: w.max(MIN_PANEL.width), height: h.max(MIN_PANEL.height) };
        }
    }
    {
        let s = floating.scale();
        let primary = win::monitors().into_iter().find(|(b, _)| b.x == 0.0 && b.y == 0.0).map(|(_, w)| w);
        let work = primary.map(|w| Rect { x: w.x / s, y: w.y / s, width: w.width / s, height: w.height / s }).unwrap_or(Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1040.0 });
        floating.set_bounds(collapsed_window_bounds(default_ball_origin(work)));
    }

    let mut frame: Option<Frame> = None;
    let mut shown = false;
    let mut on_page = false;

    event_loop.run(move |event, target, control_flow| {
        *control_flow = if floating.anim.is_some() { ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(16)) } else { ControlFlow::Wait };
        match event {
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => floating.step_anim(),
            Event::UserEvent(UserEvent::PageLoaded(url)) => {
                log_line(&format!("page loaded {}", url.split('?').next().unwrap_or("")));
                if url.starts_with(&page_url) {
                    on_page = true;
                    if !shown {
                        shown = true;
                        floating.window.set_visible(true);
                    }
                } else if !on_page && url.starts_with(&base) {
                    // The one-time login URL set the Host cookie (303 -> index); now open Orb's floating document.
                    let _ = floating.webview.load_url(&page_url);
                }
            }
            Event::UserEvent(UserEvent::Eval(code)) => {
                let wrapped = format!("(async () => {{ try {{ const r = await (async () => {{ {code} }})(); console.warn('eval-result', JSON.stringify(r)) }} catch (e) {{ console.warn('eval-error', e && (e.stack || e.message) || e) }} }})()");
                let _ = floating.webview.evaluate_script(&wrapped);
            }
            Event::UserEvent(UserEvent::Ipc(body)) => handle_ipc(&mut floating, &body, control_flow),
            Event::UserEvent(UserEvent::Host(msg)) => match msg["type"].as_str().unwrap_or_default() {
                "overlay-guard" => {
                    let id = msg["requestId"].clone();
                    let mode = msg["mode"].as_str().unwrap_or("capture");
                    let begin = msg["action"].as_str() == Some("begin");
                    floating.overlay_guard(mode, begin);
                    if mode == "input" && begin {
                        // Orb's overlayGuardInputApplyDelay: let click-through settle before the agent clicks.
                        std::thread::sleep(Duration::from_millis(80));
                    }
                    send_host(json!({ "type": "overlay-guard-ack", "requestId": id, "excludeWindowIds": [] }));
                }
                "observation-frame" => {
                    let id = msg["requestId"].clone();
                    show_observation_frame(&mut frame, target, &mut web_context, &frame_url, &msg["bounds"]);
                    send_host(json!({ "type": "observation-frame-ack", "requestId": id }));
                }
                "sck-capture" => {
                    send_host(json!({ "type": "sck-capture-ack", "requestId": msg["requestId"], "error": "sck-capture is macOS-only" }));
                }
                "event" => {
                    floating.emit(msg["channel"].as_str().unwrap_or_default(), msg["payload"].clone());
                }
                "quit" => *control_flow = ControlFlow::Exit,
                _ => {}
            },
            Event::UserEvent(UserEvent::HostClosed) => {
                floating.reset_overlay_guard();
                *control_flow = ControlFlow::Exit;
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *control_flow = ControlFlow::Exit,
            _ => {}
        }
    });
}

fn handle_ipc(f: &mut Floating, body: &str, control_flow: &mut ControlFlow) {
    let Ok(msg) = serde_json::from_str::<Value>(body) else { return };
    if msg["type"].as_str() == Some("log") {
        log_line(&format!("[js {}] {} ({})", msg["level"].as_str().unwrap_or("?"), msg["text"].as_str().unwrap_or(""), msg["url"].as_str().unwrap_or("")));
        return;
    }
    if msg["type"].as_str() != Some("invoke") {
        return;
    }
    log_line(&format!("invoke {} {}", msg["op"].as_str().unwrap_or("?"), msg["args"]));
    let id = msg["id"].as_u64().unwrap_or(0);
    let args = msg["args"].as_array().cloned().unwrap_or_default();
    let num = |i: usize| args.get(i).and_then(Value::as_f64);
    let flag = |i: usize, default: bool| args.get(i).and_then(Value::as_bool).unwrap_or(default);
    match msg["op"].as_str().unwrap_or_default() {
        "floatingMove" => match (num(0), num(1)) {
            (Some(x), Some(y)) => {
                let r = f.move_ball(x, y, flag(2, true));
                f.reply(id, serde_json::to_value(r).unwrap());
            }
            _ => f.reply_error(id, "dsh desktop: invalid floating move"),
        },
        "floatingClamp" => {
            if let Some(r) = f.clamp_window(flag(0, true), id) {
                f.reply(id, serde_json::to_value(r).unwrap());
            }
        }
        "floatingUnsnap" => {
            if let Some(r) = f.unsnap(id) {
                f.reply(id, serde_json::to_value(r).unwrap());
            }
        }
        "floatingSetExpanded" => {
            let r = f.set_expanded(flag(0, false));
            f.reply(id, serde_json::to_value(r).unwrap());
        }
        "floatingResize" => match (num(0), num(1)) {
            (Some(w), Some(h)) => {
                let p = f.resize_panel(w, h);
                f.reply(id, json!({ "width": p.width, "height": p.height }));
            }
            _ => f.reply_error(id, "orb-shell: invalid panel size"),
        },
        "floatingPanelSize" => f.reply(id, json!({ "width": f.panel.width, "height": f.panel.height })),
        "floatingFocusMain" => {
            win::open_url("dsh://open");
            f.reply(id, Value::Null);
        }
        "floatingQuit" => {
            f.reply(id, Value::Null);
            *control_flow = ControlFlow::Exit;
        }
        "floatingRunning" => {
            f.session_running = flag(0, false);
            f.reply(id, Value::Null);
        }
        "floatingEditing" => {
            f.text_editing = flag(0, false);
            f.reply(id, Value::Null);
        }
        "floatingRestoreFront" => f.reply(id, Value::Null),
        "contextMenu" => {
            let items: Vec<win::MenuItem> = args.first().cloned().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
            let chosen = win::popup_menu(f.hwnd(), &items);
            f.reply(id, chosen.map_or(Value::Null, |c| json!(c)));
        }
        op => f.reply_error(id, &format!("orb-shell: unsupported operation {op}")),
    }
}

fn show_observation_frame(frame: &mut Option<Frame>, target: &tao::event_loop::EventLoopWindowTarget<UserEvent>, ctx: &mut WebContext, url: &str, bounds: &Value) {
    if bounds.is_null() {
        if let Some(f) = frame {
            f.window.set_visible(false);
        }
        return;
    }
    let num = |k: &str| bounds[k].as_f64().unwrap_or(0.0);
    let region = Rect { x: num("x"), y: num("y"), width: num("width"), height: num("height") };
    if frame.is_none() {
        let window = WindowBuilder::new()
            .with_decorations(false)
            .with_transparent(true)
            .with_always_on_top(true)
            .with_resizable(false)
            .with_visible(false)
            .with_focused(false)
            .with_skip_taskbar(true)
            .with_undecorated_shadow(false)
            .with_inner_size(PhysicalSize::new(1u32, 1u32))
            .build(target);
        let Ok(window) = window else { return };
        let _ = window.set_ignore_cursor_events(true);
        win::exclude_from_capture(window.hwnd() as HWND, true);
        let Ok(webview) = WebViewBuilder::new_with_web_context(ctx).with_transparent(true).with_background_color((0, 0, 0, 0)).with_url(url).build(&window) else { return };
        *frame = Some(Frame { window, webview });
    }
    let Some(f) = frame else { return };
    // observationFramePlacement, in physical pixels (the region arrives in physical screen pixels on Windows).
    let work = win::monitors()
        .into_iter()
        .map(|(_, w)| w)
        .find(|w| region.x + region.width / 2.0 >= w.x && region.x + region.width / 2.0 < w.x + w.width && region.y + region.height / 2.0 >= w.y && region.y + region.height / 2.0 < w.y + w.height)
        .unwrap_or(region);
    let want = Rect { x: (region.x - 36.0).round(), y: (region.y - 36.0).round(), width: (region.width + 72.0).round().max(1.0), height: (region.height + 72.0).round().max(1.0) };
    let x = want.x.max(work.x);
    let y = want.y.max(work.y);
    let bounds = Rect { x, y, width: ((want.x + want.width).min(work.x + work.width) - x).max(1.0), height: ((want.y + want.height).min(work.y + work.height) - y).max(1.0) };
    let s = f.window.scale_factor();
    let pad = |inset: f64| ((inset.round().max(0.0) - 8.0).max(0.0) / s, 8.0);
    let (gl, _) = pad(region.x - bounds.x);
    let (gt, _) = pad(region.y - bounds.y);
    let (gr, _) = pad(bounds.x + bounds.width - (region.x + region.width));
    let (gb, _) = pad(bounds.y + bounds.height - (region.y + region.height));
    let css = format!(
        "(() => {{ const r = document.documentElement.style; r.setProperty('--glow-top','{gt}px'); r.setProperty('--glow-right','{gr}px'); r.setProperty('--glow-bottom','{gb}px'); r.setProperty('--glow-left','{gl}px'); for (const k of ['top','right','bottom','left']) r.setProperty('--stroke-' + k, '8px'); }})()"
    );
    let _ = f.webview.evaluate_script(&css);
    f.window.set_outer_position(PhysicalPosition::new(bounds.x as i32, bounds.y as i32));
    f.window.set_inner_size(PhysicalSize::new(bounds.width as u32, bounds.height as u32));
    f.window.set_visible(true);
}

static HELLO: std::sync::OnceLock<std::sync::Mutex<Option<std::sync::mpsc::Receiver<Value>>>> = std::sync::OnceLock::new();

fn spawn_stdin_reader(proxy: EventLoopProxy<UserEvent>) {
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    let _ = HELLO.set(std::sync::Mutex::new(Some(rx)));
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut first = true;
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
            if first && value["type"].as_str() == Some("hello") {
                first = false;
                let _ = tx.send(value);
                continue;
            }
            let _ = proxy.send_event(UserEvent::Host(value));
        }
        let _ = proxy.send_event(UserEvent::HostClosed);
        drop(tx);
    });
}

fn wait_hello() -> Option<Value> {
    let lock = HELLO.get()?;
    let rx = lock.lock().ok()?.take()?;
    rx.recv().ok()
}
