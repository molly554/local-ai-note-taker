//! Windows: who records from a microphone (Core Audio sessions, then the privacy ConsentStore), running programs
//! (Toolhelp) and window titles (EnumWindows). None of these need a permission.

use crate::parse::{self, MicApp, Proc};
use std::collections::HashMap;
use windows::core::{Interface, PWSTR};
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM};
use windows::Win32::Media::Audio::{
    eCapture, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
    DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

const CONSENT: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

fn utf16(buf: &[u16]) -> String {
    let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

fn processes() -> HashMap<u32, Proc> {
    let mut map = HashMap::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return map };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                map.insert(e.th32ProcessID, Proc { exe: utf16(&e.szExeFile), parent: e.th32ParentProcessID });
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    map
}

fn image_path(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, BOOL(0), pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(h);
        r.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/** Processes with an active (not paused, not idle) session on any microphone */
unsafe fn capturing() -> windows::core::Result<Vec<u32>> {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let list = devices.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)?;
    let mut pids = Vec::new();
    for i in 0..list.GetCount()? {
        let Ok(device) = list.Item(i) else { continue };
        let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
        let sessions = manager.GetSessionEnumerator()?;
        for j in 0..sessions.GetCount()? {
            let Ok(session) = sessions.GetSession(j) else { continue };
            if session.GetState().ok() != Some(AudioSessionStateActive) {
                continue;
            }
            let Ok(session) = session.cast::<IAudioSessionControl2>() else { continue };
            // S_OK means the system sounds session
            if session.IsSystemSoundsSession().0 == 0 {
                continue;
            }
            if let Ok(pid) = session.GetProcessId() {
                if pid != 0 {
                    pids.push(pid);
                }
            }
        }
    }
    Ok(pids)
}

/** ConsentStore keys marked in use: (key name, true for a Store package family, false for a program path) */
fn consent() -> Vec<(String, bool)> {
    let mut found = Vec::new();
    let Ok(root) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(CONSENT) else { return found };
    let mut scan = |key: &RegKey, packaged: bool| {
        for name in key.enum_keys().flatten() {
            if name == "NonPackaged" {
                continue;
            }
            let Ok(k) = key.open_subkey(&name) else { continue };
            let start: u64 = k.get_value("LastUsedTimeStart").unwrap_or(0);
            let stop: u64 = k.get_value("LastUsedTimeStop").unwrap_or(0);
            if parse::consent_in_use(start, stop) {
                found.push((name, packaged));
            }
        }
    };
    scan(&root, true);
    if let Ok(np) = root.open_subkey("NonPackaged") {
        scan(&np, false);
    }
    found
}

fn app(pid: u32, exe: &str) -> MicApp {
    MicApp { bundle_id: parse::exe_id(exe), name: parse::exe_name(exe), pid }
}

pub fn mic_apps() -> Vec<MicApp> {
    let procs = processes();
    let me = std::process::id();
    let mut sessions = Vec::new();
    match unsafe { capturing() } {
        Ok(pids) => {
            for pid in pids.into_iter().filter(|p| *p != me) {
                let owner = parse::owner(pid, &procs);
                if let Some(p) = procs.get(&owner) {
                    sessions.push(app(owner, &p.exe));
                }
            }
        }
        Err(e) => eprintln!("audio sessions: {e}"),
    }
    // an entry left "in use" by an app that crashed counts only while that app still runs
    let mut fallback = Vec::new();
    for (key, packaged) in consent() {
        let hits: Vec<u32> = if packaged {
            procs.keys().copied().filter(|pid| image_path(*pid).is_some_and(|path| parse::in_package(&path, &key))).collect()
        } else {
            let exe = parse::exe_id(&key);
            procs.iter().filter(|(_, p)| parse::exe_id(&p.exe) == exe).map(|(pid, _)| *pid).collect()
        };
        if let Some(pid) = parse::root_of(&hits, &procs) {
            fallback.push(app(pid, &procs[&pid].exe));
        }
    }
    parse::merge(sessions, fallback)
}

pub fn running_apps(ids: &[String]) -> Vec<String> {
    let names: std::collections::HashSet<String> = processes().values().map(|p| parse::exe_id(&p.exe)).collect();
    ids.iter().filter(|id| names.contains(&id.to_lowercase())).cloned().collect()
}

unsafe extern "system" fn each_window(hwnd: HWND, data: LPARAM) -> BOOL {
    let found = &mut *(data.0 as *mut Vec<(u64, u32, String)>);
    if IsWindowVisible(hwnd).as_bool() {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut buf);
        if n > 0 {
            found.push((hwnd.0 as usize as u64, pid, String::from_utf16_lossy(&buf[..n as usize])));
        }
    }
    BOOL(1)
}

/** The app's foreground window title, else its topmost visible one. EnumWindows lists top-level windows top first. */
pub fn window_title(id: &str) -> Option<String> {
    let id = id.to_lowercase();
    let procs = processes();
    let mut found: Vec<(u64, u32, String)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(each_window), LPARAM(&mut found as *mut _ as isize));
    }
    let active = unsafe { GetForegroundWindow() }.0 as usize as u64;
    let windows: Vec<(u64, bool, String)> =
        found.into_iter().map(|(h, pid, title)| (h, procs.get(&pid).is_some_and(|p| parse::exe_id(&p.exe) == id), title)).collect();
    parse::pick_window(&windows, (active != 0).then_some(active))
}
