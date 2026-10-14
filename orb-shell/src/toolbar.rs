//! Selection toolbar window and controller, ported from DeepSeek Orb 0.1.7 `lib/main.js`
//! (`SelectionToolbarController`, `selectionToolbarBounds`, `selectionToolbarMenuBounds`, `selection-toolbar-config`).
//! Geometry is done in physical pixels: the hooks and UI Automation report physical screen coordinates.

use crate::geometry::{clamp, Rect};
use crate::{bridge_emit, selection, win};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tao::platform::windows::WindowExtWindows;
use tao::window::Window;
use windows_sys::Win32::Foundation::HWND;
use wry::WebView;

/// Orb `SELECTION_TOOLBAR_SIZE` (DIP).
const TOOLBAR_W: f64 = 280.0;
const TOOLBAR_H: f64 = 46.0;
const DEDUPE_MS: u128 = 3000;
const DESKTOP_SELECTION_PREAMBLE: &str = "Desktop selection. Answer in this chat only. Do not call GUI tools or code_agent.";

pub fn search_url(text: &str) -> String {
    let encoded: String = text
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect();
    format!("https://www.bing.com/search?q={encoded}")
}

pub fn translate_prompt(text: &str, language: &str) -> String {
    format!("{DESKTOP_SELECTION_PREAMBLE}\n\nTranslate the following into {}:\n\n{text}", if language == "en" { "English" } else { "Chinese" })
}

pub struct Toolbar {
    pub window: Window,
    pub webview: WebView,
    pub visible: bool,
    pub enabled: bool,
    pub language: String,
    pub last_text: String,
    pub last_pid: Option<u32>,
    /// Orb `monitor.lastFrontPid()`: the last app a selection was read from.
    pub last_front: Option<u32>,
    pub anchor: (f64, f64),
    pub bar_origin: (f64, f64),
    dedupe: Option<(String, Instant)>,
    hooks: Option<selection::Hooks>,
    config_file: Option<PathBuf>,
}

impl Toolbar {
    pub fn new(window: Window, webview: WebView, profile: Option<&str>) -> Self {
        let _ = win::make_no_activate(window.hwnd() as HWND);
        let mut toolbar = Toolbar {
            window,
            webview,
            visible: false,
            enabled: true,
            language: "zh".into(),
            last_text: String::new(),
            last_pid: None,
            last_front: None,
            anchor: (0.0, 0.0),
            bar_origin: (0.0, 0.0),
            dedupe: None,
            hooks: None,
            config_file: profile.map(|p| PathBuf::from(p).join("selection-toolbar.json")),
        };
        toolbar.load_config();
        toolbar
    }

    fn hwnd(&self) -> HWND {
        self.window.hwnd() as HWND
    }

    /// `readSelectionToolbarConfig` (defaults: enabled, translate to Chinese).
    pub fn load_config(&mut self) {
        let value = self.config_file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null);
        self.enabled = value["enabled"].as_bool().unwrap_or(true);
        self.language = match value["translateTargetLanguage"].as_str() {
            Some("en") => "en".into(),
            _ => "zh".into(),
        };
    }

    fn write_config(&self) {
        if let Some(file) = &self.config_file {
            let _ = std::fs::write(file, format!("{}\n", serde_json::to_string_pretty(&json!({ "enabled": self.enabled, "translateTargetLanguage": self.language })).unwrap()));
        }
    }

    /// Start or stop the hooks to match `enabled` (Orb `start` / `stop`).
    pub fn sync_hooks(&mut self, install: impl FnOnce() -> Option<selection::Hooks>) {
        if self.enabled && self.hooks.is_none() {
            self.hooks = install();
        } else if !self.enabled {
            self.hooks = None;
            self.hide();
        }
    }

    pub fn hide(&mut self) {
        if self.visible {
            self.visible = false;
            win::hide(self.hwnd());
        }
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        if !self.visible {
            return false;
        }
        let r = win::window_rect(self.hwnd());
        x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height
    }

    fn work_area_at(x: f64, y: f64) -> Rect {
        win::monitors()
            .into_iter()
            .map(|(_, w)| w)
            .find(|w| x >= w.x && x < w.x + w.width && y >= w.y && y < w.y + w.height)
            .or_else(|| win::monitors().into_iter().map(|(_, w)| w).next())
            .unwrap_or(Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1040.0 })
    }

    /// `onSelection` minus the reads: dedupe, remember, place (`selectionToolbarBounds`) and show without focus.
    pub fn on_selection(&mut self, sel: selection::Selection) {
        let key = format!("{}\0{}", sel.pid.unwrap_or(0), sel.text);
        if let Some((last, at)) = &self.dedupe {
            if *last == key && at.elapsed().as_millis() < DEDUPE_MS {
                return;
            }
        }
        self.dedupe = Some((key, Instant::now()));
        self.last_text = sel.text;
        self.last_pid = sel.pid;
        if let Some((x, y, _, _)) = sel.rect {
            self.anchor = (x, y);
        }
        let s = self.window.scale_factor();
        let (w, h) = (TOOLBAR_W * s, TOOLBAR_H * s);
        let work = Self::work_area_at(self.anchor.0, self.anchor.1);
        let x = clamp(self.anchor.0, work.x, work.x + work.width - w);
        let y = clamp(self.anchor.1 + 8.0 * s, work.y, work.y + work.height - h);
        self.bar_origin = (x, y);
        win::set_window_rect(self.hwnd(), Rect { x, y, width: w, height: h });
        win::show_no_activate(self.hwnd());
        self.visible = true;
        self.publish_state();
    }

    pub fn publish_state(&self) {
        bridge_emit(&self.webview, "selection-state", json!({ "language": self.language }));
    }

    pub fn set_language(&mut self, language: &str) {
        self.language = if language == "en" { "en".into() } else { "zh".into() };
        self.write_config();
        self.publish_state();
    }

    /// `selectionToolbarMenuBounds`: grow for the language menu, above the bar when it does not fit below.
    pub fn set_content_size(&mut self, width: f64, height: f64) -> bool {
        let s = self.window.scale_factor();
        let (w, h) = ((width.round().max(1.0)) * s, (height.round().max(1.0)) * s);
        let (bx, by) = self.bar_origin;
        let work = Self::work_area_at(bx, by);
        let x = clamp(bx, work.x, work.x + work.width - w);
        let y = if by + h <= work.y + work.height || h <= TOOLBAR_H * s {
            clamp(by, work.y, work.y + work.height - h)
        } else {
            clamp(by + TOOLBAR_H * s - h, work.y, work.y + work.height - h)
        };
        win::set_window_rect(self.hwnd(), Rect { x, y, width: w, height: h });
        y < by
    }

    /// Orb `scheduleRestoreFrontApp`: give focus back to the app the text came from, now and once more after 80 ms.
    pub fn restore_front_app(&self) {
        if let Some(pid) = self.last_pid {
            if selection::is_excluded(pid) {
                return;
            }
            selection::activate_pid(pid);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(80));
                selection::activate_pid(pid);
            });
        }
    }
}
