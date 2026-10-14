//! Selection toolbar backend, ported from DeepSeek Orb 0.1.7 `lib/main.js`
//! (`installWindowsSelectionHooks`, `dispatchWindowsSelectionMessage`, `readWindowsSelection`, `activateWindowsPid`).
//! Low-level mouse/keyboard hooks run on their own thread; every left-button release reads the focused element's
//! UI Automation text selection with the same PowerShell script Orb used.

use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, TRUE, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, EnumWindows, GetMessageW, GetWindowThreadProcessId, IsWindowVisible, PostThreadMessageW, SetForegroundWindow,
    SetWindowsHookExW, UnhookWindowsHookEx, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEWHEEL, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN,
};

/// Orb `SELECTION_SCRIPT`, unchanged.
const SELECTION_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -eq $focused) { return }
$pattern = $null
if (-not $focused.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { return }
$ranges = @($pattern.GetSelection())
if ($ranges.Length -lt 1) { return }
$text = $ranges[0].GetText(4000)
if ([string]::IsNullOrWhiteSpace($text)) { return }
$rects = @($ranges[0].GetBoundingRectangles())
$x = 0; $y = 0; $width = 0; $height = 0
if ($rects.Length -ge 4) { $x = $rects[0]; $y = $rects[1]; $width = $rects[2]; $height = $rects[3] }
[pscustomobject]@{
  text = $text; x = $x; y = $y; width = $width; height = $height; pid = $focused.Current.ProcessId
} | ConvertTo-Json -Compress
"#;

/// Hook messages, in physical screen pixels (Orb converted to DIP later; we keep physical and convert at use).
#[derive(Debug, Clone)]
pub enum HookEvent {
    /// Any key press or the wheel: hide the toolbar.
    Dismiss,
    /// A non-left button: hide the toolbar.
    OtherButton,
    MouseDown { x: f64, y: f64 },
    MouseUp { x: f64, y: f64 },
}

#[derive(Debug, Clone)]
pub struct Selection {
    pub text: String,
    pub pid: Option<u32>,
    /// UI Automation bounding rectangle of the first line (physical pixels), when available.
    pub rect: Option<(f64, f64, f64, f64)>,
}

static SINK: OnceLock<Box<dyn Fn(HookEvent) + Send + Sync>> = OnceLock::new();

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        if let Some(sink) = SINK.get() {
            let info = &*(lparam as *const MSLLHOOKSTRUCT);
            let (x, y) = (info.pt.x as f64, info.pt.y as f64);
            match wparam as u32 {
                WM_MOUSEWHEEL => sink(HookEvent::Dismiss),
                WM_LBUTTONDOWN => sink(HookEvent::MouseDown { x, y }),
                WM_LBUTTONUP => sink(HookEvent::MouseUp { x, y }),
                WM_RBUTTONDOWN | WM_RBUTTONUP | WM_MBUTTONDOWN | WM_MBUTTONUP => sink(HookEvent::OtherButton),
                _ => {}
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && (wparam as u32 == WM_KEYDOWN || wparam as u32 == WM_SYSKEYDOWN) {
        let _ = &*(lparam as *const KBDLLHOOKSTRUCT);
        if let Some(sink) = SINK.get() {
            sink(HookEvent::Dismiss);
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

/// Running hook thread; dropping it unhooks.
pub struct Hooks {
    thread_id: u32,
}

impl Drop for Hooks {
    fn drop(&mut self) {
        unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0) };
    }
}

/// Install the low-level hooks on a dedicated message-loop thread. The sink is fixed for the process lifetime.
pub fn install(sink: impl Fn(HookEvent) + Send + Sync + 'static) -> Option<Hooks> {
    let _ = SINK.set(Box::new(sink));
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || unsafe {
        let module = GetModuleHandleW(std::ptr::null());
        let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module, 0);
        let keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), module, 0);
        let _ = tx.send(GetCurrentThreadId());
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
        if !mouse.is_null() {
            UnhookWindowsHookEx(mouse);
        }
        if !keyboard.is_null() {
            UnhookWindowsHookEx(keyboard);
        }
    });
    rx.recv_timeout(Duration::from_secs(2)).ok().map(|thread_id| Hooks { thread_id })
}

/// Orb `readWindowsSelection`: run the UI Automation script with a 1.5 s budget.
pub fn read_selection() -> Option<Selection> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-STA", "-Command", SELECTION_SCRIPT])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_millis(1500);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(30)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let mut out = String::new();
    std::io::Read::read_to_string(child.stdout.as_mut()?, &mut out).ok()?;
    let value: serde_json::Value = serde_json::from_str(out.trim()).ok()?;
    let text = value["text"].as_str()?.to_string();
    if text.trim().is_empty() {
        return None;
    }
    let num = |k: &str| value[k].as_f64();
    let rect = match (num("x"), num("y"), num("width"), num("height")) {
        (Some(x), Some(y), Some(w), Some(h)) if w > 0.0 && h > 0.0 => Some((x, y, w, h)),
        _ => None,
    };
    Some(Selection { text, pid: value["pid"].as_u64().map(|p| p as u32), rect })
}

/// Executable file name of a process (lower-case), used to exclude Harness and ourselves like Orb excluded itself.
pub fn process_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit('\\').next().map(|n| n.to_lowercase())
    }
}

pub fn is_excluded(pid: u32) -> bool {
    pid == std::process::id() || matches!(process_name(pid).as_deref(), Some("deepseek harness.exe") | Some("orb-shell.exe"))
}

/// Orb `activateWindowsPid`: bring the first visible top-level window of `pid` to the foreground.
pub fn activate_pid(pid: u32) {
    unsafe extern "system" fn each(hwnd: HWND, data: LPARAM) -> BOOL {
        let state = &mut *(data as *mut (u32, bool));
        if state.1 || IsWindowVisible(hwnd) == 0 {
            return TRUE;
        }
        let mut owner = 0u32;
        GetWindowThreadProcessId(hwnd, &mut owner);
        if owner == state.0 {
            SetForegroundWindow(hwnd);
            state.1 = true;
        }
        TRUE
    }
    let mut state = (pid, false);
    unsafe { EnumWindows(Some(each), &mut state as *mut _ as LPARAM) };
}
