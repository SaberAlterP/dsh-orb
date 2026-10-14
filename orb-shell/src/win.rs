//! Small Win32 helpers the companion needs beyond tao/wry.

use crate::geometry::Rect;
use std::ffi::c_void;
use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{HWND, LPARAM, POINT, RECT, TRUE};
use windows_sys::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, AppendMenuW, CreatePopupMenu, DestroyMenu, GetCursorPos, GetWindowRect, SetForegroundWindow, SetWindowDisplayAffinity,
    SetWindowPos, TrackPopupMenu, HMENU, HWND_TOPMOST, MF_CHECKED, MF_GRAYED, MF_POPUP, MF_SEPARATOR, MF_STRING,
    SWP_NOACTIVATE, SW_SHOWNORMAL, TPM_NONOTIFY, TPM_RETURNCMD, TPM_RIGHTBUTTON, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn rect(r: RECT) -> Rect {
    Rect { x: r.left as f64, y: r.top as f64, width: (r.right - r.left) as f64, height: (r.bottom - r.top) as f64 }
}

/// Physical-pixel monitor rectangles: (bounds, work area).
pub fn monitors() -> Vec<(Rect, Rect)> {
    unsafe extern "system" fn each(monitor: HMONITOR, _dc: HDC, _clip: *mut RECT, data: LPARAM) -> BOOL {
        let out = &mut *(data as *mut Vec<(Rect, Rect)>);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) != 0 {
            out.push((rect(info.rcMonitor), rect(info.rcWork)));
        }
        TRUE
    }
    let mut out: Vec<(Rect, Rect)> = Vec::new();
    unsafe {
        EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), Some(each), &mut out as *mut _ as LPARAM);
    }
    out
}

pub fn window_rect(hwnd: HWND) -> Rect {
    let mut r: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetWindowRect(hwnd, &mut r) };
    rect(r)
}

/// Move/resize in physical pixels, keeping the topmost band and focus untouched.
pub fn set_window_rect(hwnd: HWND, r: Rect) {
    unsafe {
        SetWindowPos(hwnd, HWND_TOPMOST, r.x.round() as i32, r.y.round() as i32, r.width.round() as i32, r.height.round() as i32, SWP_NOACTIVATE);
    }
}

/// Orb's `setContentProtection(true)` on Windows: keep the window out of screenshots.
pub fn exclude_from_capture(hwnd: HWND, on: bool) {
    unsafe {
        SetWindowDisplayAffinity(hwnd, if on { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE });
    }
}

pub fn cursor() -> (f64, f64) {
    let mut p = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut p) };
    (p.x as f64, p.y as f64)
}

/// Open a URL with the shell (used for `dsh://open`, which DeepSeek Harness answers by focusing its main window).
pub fn open_url(url: &str) {
    // We hold the foreground (the user just clicked us); let the launched Harness instance take it.
    unsafe { AllowSetForegroundWindow(u32::MAX) };
    let verb = wide("open");
    let file = wide(url);
    unsafe {
        ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL);
    }
}

/// Native popup menu item tree, built by the renderer (Orb's `floatingContextMenuTemplate`).
#[derive(serde::Deserialize)]
pub struct MenuItem {
    #[serde(default)]
    pub id: Option<u32>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub separator: bool,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
    #[serde(default)]
    pub checked: bool,
    #[serde(default)]
    pub submenu: Option<Vec<MenuItem>>,
}

fn enabled_default() -> bool {
    true
}

unsafe fn build_menu(items: &[MenuItem]) -> HMENU {
    let menu = CreatePopupMenu();
    for item in items {
        if item.separator {
            AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
            continue;
        }
        let label = wide(item.label.as_deref().unwrap_or(""));
        let mut flags = MF_STRING;
        if !item.enabled {
            flags |= MF_GRAYED;
        }
        if item.checked {
            flags |= MF_CHECKED;
        }
        if let Some(sub) = &item.submenu {
            let child = build_menu(sub);
            AppendMenuW(menu, flags | MF_POPUP, child as usize, label.as_ptr());
        } else {
            AppendMenuW(menu, flags, item.id.unwrap_or(0) as usize, label.as_ptr());
        }
    }
    menu
}

/// Show the menu at the cursor and return the chosen item id (None when dismissed).
pub fn popup_menu(hwnd: HWND, items: &[MenuItem]) -> Option<u32> {
    unsafe {
        let menu = build_menu(items);
        let (x, y) = cursor();
        SetForegroundWindow(hwnd);
        let chosen = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON, x as i32, y as i32, 0, hwnd, std::ptr::null());
        DestroyMenu(menu);
        if chosen > 0 { Some(chosen as u32) } else { None }
    }
}

#[allow(dead_code)]
pub fn as_hwnd(raw: isize) -> HWND {
    raw as *mut c_void as HWND
}
