//! yogurt-mcp for Windows and Linux: what an AI app (Claude, Cursor, …) starts to read Yogurt's meetings over MCP.
//! The same as native/yogurt-mcp (Swift, Mac): it only passes messages, the AI app's stdin to Yogurt and Yogurt's
//! answers to stdout. Linux: the Unix socket in the profile folder. Windows: the named pipe whose name Yogurt
//! writes to mcp.pipe in the profile folder. The MCP server itself is in the app (src/main/mcp).
//! Yogurt not open: it is started in the background first.

use std::env;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{exit, Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const NOT_RUNNING: &str = "Lynote NoteTaker isn't running, and it couldn't be opened. Open Lynote NoteTaker, then try again.";
#[cfg_attr(windows, allow(dead_code))]
const TOO_LONG: &str = "Lynote NoteTaker's folder path is too long for its connection.";
#[cfg_attr(unix, allow(dead_code))]
const PIPE_PREFIX: &str = r"\\.\pipe\yogurt-mcp-";
#[cfg_attr(windows, allow(dead_code))]
/// a Unix socket path, its ending zero included, fits in sun_path (108 bytes on Linux)
const SUN_PATH: usize = 108;

fn fail(s: &str) -> ! {
    eprintln!("{s}");
    exit(1)
}

/// The profile folder, where the app puts it (appData + its name, src/main/paths.ts): %APPDATA%\Lynote NoteTaker on Windows,
/// $XDG_CONFIG_HOME/Lynote NoteTaker or ~/.config/Lynote NoteTaker on Linux. YOGURT_USER_DATA uses a separate one (tests).
fn profile(windows: bool, var: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let set = |k: &str| var(k).filter(|v| !v.is_empty());
    if let Some(p) = set("YOGURT_USER_DATA") {
        return Some(p.into());
    }
    if windows {
        return set("APPDATA").map(|a| PathBuf::from(a).join("Lynote NoteTaker"));
    }
    set("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| set("HOME").map(|h| PathBuf::from(h).join(".config")))
        .map(|c| c.join("Lynote NoteTaker"))
}

#[cfg_attr(unix, allow(dead_code))]
/// The pipe's name as Yogurt wrote it to mcp.pipe; anything else in that file is not followed.
fn pipe_name(file: &str) -> Option<&str> {
    let name = file.trim();
    let id = name.strip_prefix(PIPE_PREFIX)?;
    (!id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_hexdigit())).then_some(name)
}

/// What starts Yogurt: the program Yogurt recorded in mcp-launch when it last opened (the installed Yogurt.exe,
/// or the AppImage, which may have moved since). Windows without one: Yogurt.exe next to the resources folder
/// this helper is in (Yogurt\resources\bin\yogurt-mcp.exe).
fn launch_target(windows: bool, recorded: Option<String>, exe: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(r) = recorded.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        return Some(PathBuf::from(r));
    }
    if !windows {
        return None;
    }
    let exe = exe?;
    let bin = exe.parent()?;
    let resources = bin.parent()?;
    let named = |p: &Path, n: &str| p.file_name().is_some_and(|f| f.eq_ignore_ascii_case(n));
    (named(bin, "bin") && named(resources, "resources")).then(|| resources.parent().map(|app| app.join("Lynote NoteTaker.exe")))?
}

#[cfg_attr(windows, allow(dead_code))]
fn socket_too_long(path: &Path) -> bool {
    path.as_os_str().len() >= SUN_PATH
}

/// One connection to Yogurt, read on one thread while written on another.
trait Conn: Send + Sync {
    /// None: Yogurt went away. Some(0) only means try again.
    fn read(&self, buf: &mut [u8]) -> Option<usize>;
    fn write(&self, buf: &[u8]) -> Option<usize>;
    /// tells Yogurt nothing more is coming, where the connection can say so
    fn close_write(&self);
}

#[cfg(unix)]
mod sock {
    use super::Conn;
    use std::io::{Read, Write};
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;
    use std::path::Path;

    pub struct Sock(UnixStream);
    impl Conn for Sock {
        fn read(&self, buf: &mut [u8]) -> Option<usize> {
            loop {
                match (&self.0).read(buf) {
                    Ok(0) => return None,
                    Ok(n) => return Some(n),
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => return None,
                }
            }
        }
        fn write(&self, buf: &[u8]) -> Option<usize> {
            (&self.0).write(buf).ok().filter(|&n| n > 0)
        }
        fn close_write(&self) {
            let _ = self.0.shutdown(Shutdown::Write);
        }
    }

    pub fn connect(profile: &Path) -> Option<Box<dyn Conn>> {
        let path = profile.join("mcp.sock");
        if super::socket_too_long(&path) {
            super::fail(super::TOO_LONG)
        }
        UnixStream::connect(&path).ok().map(|s| Box::new(Sock(s)) as Box<dyn Conn>)
    }

    /// in its own process group, so the AI app ending its group doesn't take Yogurt with it
    pub fn start(target: &Path) -> bool {
        use std::os::unix::process::CommandExt;
        super::command(target).process_group(0).spawn().is_ok()
    }
}

#[cfg(windows)]
mod pipe {
    //! The few Windows calls needed, declared here instead of pulling in a crate.
    //! The pipe is opened for overlapped I/O: on a plain handle Windows runs one call at a time, so a read waiting
    //! for Yogurt's answer would hold up the next message to it.
    use super::Conn;
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::null_mut;

    type Handle = *mut c_void;
    #[repr(C)]
    #[allow(dead_code)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: Handle,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(name: *const u16, access: u32, share: u32, security: *mut c_void, disposition: u32, flags: u32, template: Handle) -> Handle;
        fn ReadFile(h: Handle, buf: *mut u8, len: u32, done: *mut u32, ov: *mut Overlapped) -> i32;
        fn WriteFile(h: Handle, buf: *const u8, len: u32, done: *mut u32, ov: *mut Overlapped) -> i32;
        fn GetOverlappedResult(h: Handle, ov: *mut Overlapped, done: *mut u32, wait: i32) -> i32;
        fn CreateEventW(security: *mut c_void, manual: i32, initial: i32, name: *const u16) -> Handle;
        fn CloseHandle(h: Handle) -> i32;
        fn WaitNamedPipeW(name: *const u16, timeout: u32) -> i32;
        fn GetLastError() -> u32;
        fn GetStdHandle(which: u32) -> Handle;
        fn SetHandleInformation(h: Handle, mask: u32, flags: u32) -> i32;
    }
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    // whoever serves the pipe may only see who we are, never act as us
    const SECURITY_SQOS_PRESENT: u32 = 0x0010_0000;
    const SECURITY_IDENTIFICATION: u32 = 0x0001_0000;
    const ERROR_IO_PENDING: u32 = 997;
    const ERROR_PIPE_BUSY: u32 = 231;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    const STD_HANDLES: [u32; 3] = [-10i32 as u32, -11i32 as u32, -12i32 as u32];
    const HANDLE_FLAG_INHERIT: u32 = 1;

    pub struct Pipe(Handle);
    // one handle, used by the reading and the writing thread at once, each with its own OVERLAPPED
    unsafe impl Send for Pipe {}
    unsafe impl Sync for Pipe {}

    impl Pipe {
        fn io(&self, buf: *mut u8, len: usize, write: bool) -> Option<usize> {
            unsafe {
                let event = CreateEventW(null_mut(), 1, 0, null_mut());
                if event.is_null() {
                    return None;
                }
                let mut ov = Overlapped { internal: 0, internal_high: 0, offset: 0, offset_high: 0, event };
                let len = len.min(u32::MAX as usize) as u32;
                let ok = if write { WriteFile(self.0, buf, len, null_mut(), &mut ov) } else { ReadFile(self.0, buf, len, null_mut(), &mut ov) };
                let mut done = 0u32;
                let finished = (ok != 0 || GetLastError() == ERROR_IO_PENDING) && GetOverlappedResult(self.0, &mut ov, &mut done, 1) != 0;
                CloseHandle(event);
                finished.then_some(done as usize)
            }
        }
    }
    impl Conn for Pipe {
        fn read(&self, buf: &mut [u8]) -> Option<usize> {
            self.io(buf.as_mut_ptr(), buf.len(), false)
        }
        fn write(&self, buf: &[u8]) -> Option<usize> {
            self.io(buf.as_ptr() as *mut u8, buf.len(), true).filter(|&n| n > 0)
        }
        // a pipe can't be half closed: the helper ending closes it
        fn close_write(&self) {}
    }

    pub fn connect(profile: &Path) -> Option<Box<dyn Conn>> {
        let file = std::fs::read_to_string(profile.join("mcp.pipe")).ok()?;
        let name = super::pipe_name(&file)?;
        let wide: Vec<u16> = std::ffi::OsStr::new(name).encode_wide().chain(Some(0)).collect();
        for _ in 0..2 {
            let h = unsafe {
                CreateFileW(wide.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, null_mut(), OPEN_EXISTING, FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, null_mut())
            };
            if h != INVALID_HANDLE_VALUE {
                return Some(Box::new(Pipe(h)));
            }
            // every waiting end of the pipe taken for a moment: wait for one
            if unsafe { GetLastError() } != ERROR_PIPE_BUSY {
                return None;
            }
            unsafe { WaitNamedPipeW(wide.as_ptr(), 2000) };
        }
        None
    }

    /// Detached, and out of the AI app's job when it allows that, so closing the AI app doesn't close Yogurt.
    pub fn start(target: &Path) -> bool {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        // Yogurt would otherwise inherit the AI app's stdin and stdout, and the AI app would wait on them after we end
        for which in STD_HANDLES {
            unsafe { SetHandleInformation(GetStdHandle(which), HANDLE_FLAG_INHERIT, 0) };
        }
        let flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
        super::command(target).creation_flags(flags | CREATE_BREAKAWAY_FROM_JOB).spawn().is_ok()
            || super::command(target).creation_flags(flags).spawn().is_ok()
    }
}

#[cfg(unix)]
use sock::{connect, start};
#[cfg(windows)]
use pipe::{connect, start};

/// Yogurt with --hidden: it opens without a window, so starting a chat never pulls Yogurt in front
fn command(target: &Path) -> Command {
    let mut c = Command::new(target);
    c.arg("--hidden").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    c
}

fn main() {
    let windows = cfg!(windows);
    let profile = profile(windows, |k| env::var_os(k)).unwrap_or_else(|| fail(NOT_RUNNING));
    let mut conn = connect(&profile);
    if conn.is_none() && env::var_os("YOGURT_MCP_NO_LAUNCH").is_none() {
        let recorded = std::fs::read_to_string(profile.join("mcp-launch")).ok();
        if let Some(target) = launch_target(windows, recorded, env::current_exe().ok()) {
            if start(&target) {
                for _ in 0..60 {
                    thread::sleep(Duration::from_millis(500));
                    if let Some(c) = connect(&profile) {
                        conn = Some(c);
                        break;
                    }
                }
            }
        }
    }
    let conn: Arc<dyn Conn> = Arc::from(conn.unwrap_or_else(|| fail(NOT_RUNNING)));

    // Yogurt's answers → stdout; when Yogurt goes away, so does this
    let from = conn.clone();
    thread::spawn(move || {
        let mut out = io::stdout().lock();
        let mut buf = vec![0u8; 65536];
        loop {
            match from.read(&mut buf) {
                None => exit(0),
                Some(0) => continue,
                Some(n) => {
                    if out.write_all(&buf[..n]).and_then(|_| out.flush()).is_err() {
                        exit(0)
                    }
                }
            }
        }
    });
    // the AI app's messages → Yogurt; the app closing stdin ends the session
    let mut input = io::stdin().lock();
    let mut buf = vec![0u8; 65536];
    loop {
        let n = match input.read(&mut buf) {
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => 0,
        };
        if n == 0 {
            conn.close_write();
            thread::sleep(Duration::from_millis(200));
            exit(0)
        }
        let mut off = 0;
        while off < n {
            match conn.write(&buf[off..n]) {
                Some(w) => off += w,
                None => exit(0),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let m: HashMap<String, OsString> = pairs.iter().map(|(k, v)| (k.to_string(), OsString::from(v))).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn profile_is_where_electron_puts_it() {
        let win = env_of(&[("APPDATA", r"C:\Users\sam\AppData\Roaming"), ("HOME", "/h")]);
        assert_eq!(profile(true, &win), Some(PathBuf::from(r"C:\Users\sam\AppData\Roaming").join("Lynote NoteTaker")));
        assert_eq!(profile(false, env_of(&[("HOME", "/home/sam")])), Some(PathBuf::from("/home/sam/.config/Lynote NoteTaker")));
        assert_eq!(profile(false, env_of(&[("HOME", "/home/sam"), ("XDG_CONFIG_HOME", "/cfg")])), Some(PathBuf::from("/cfg/Lynote NoteTaker")));
        // empty means not set, as for Electron
        assert_eq!(profile(false, env_of(&[("HOME", "/home/sam"), ("XDG_CONFIG_HOME", "")])), Some(PathBuf::from("/home/sam/.config/Lynote NoteTaker")));
        assert_eq!(profile(true, env_of(&[])), None);
    }

    #[test]
    fn a_separate_profile_wins() {
        let e = env_of(&[("YOGURT_USER_DATA", "/tmp/p"), ("APPDATA", "C:/x"), ("HOME", "/h")]);
        assert_eq!(profile(true, &e), Some(PathBuf::from("/tmp/p")));
        assert_eq!(profile(false, &e), Some(PathBuf::from("/tmp/p")));
    }

    #[test]
    fn only_yogurts_own_pipe_names_are_followed() {
        assert_eq!(pipe_name("\\\\.\\pipe\\yogurt-mcp-0a1B\r\n"), Some(r"\\.\pipe\yogurt-mcp-0a1B"));
        assert_eq!(pipe_name(r"\\.\pipe\yogurt-mcp-"), None);
        assert_eq!(pipe_name(r"\\.\pipe\other"), None);
        assert_eq!(pipe_name(r"\\.\pipe\yogurt-mcp-ab\..\other"), None);
        assert_eq!(pipe_name(r"\\server\pipe\yogurt-mcp-ab"), None);
        assert_eq!(pipe_name(""), None);
    }

    #[test]
    fn yogurt_is_started_from_where_it_said() {
        assert_eq!(launch_target(false, Some("/home/sam/Apps/Yogurt.AppImage\n".into()), None), Some(PathBuf::from("/home/sam/Apps/Yogurt.AppImage")));
        assert_eq!(launch_target(true, Some(r"D:\Yogurt\Yogurt.exe".into()), None), Some(PathBuf::from(r"D:\Yogurt\Yogurt.exe")));
        // Linux with nothing recorded: no idea where the AppImage is
        assert_eq!(launch_target(false, None, Some("/home/sam/.config/Yogurt/bin/yogurt-mcp".into())), None);
        assert_eq!(launch_target(false, Some("  ".into()), None), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_falls_back_to_the_install_folder() {
        let exe = PathBuf::from(r"C:\Users\sam\AppData\Local\Programs\lynote-notetaker\resources\bin\yogurt-mcp.exe");
        assert_eq!(launch_target(true, None, Some(exe)), Some(PathBuf::from(r"C:\Users\sam\AppData\Local\Programs\lynote-notetaker\Lynote NoteTaker.exe")));
        assert_eq!(launch_target(true, None, Some(PathBuf::from(r"C:\tools\yogurt-mcp.exe"))), None);
    }

    #[test]
    fn long_socket_paths_are_caught() {
        assert!(!socket_too_long(Path::new("/home/sam/.config/Yogurt/mcp.sock")));
        assert!(socket_too_long(&PathBuf::from(format!("/{}/mcp.sock", "a".repeat(100)))));
    }
}
