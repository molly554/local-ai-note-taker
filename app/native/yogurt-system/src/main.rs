//! yogurt-system: the call-detection subcommands of yogurt-mac (app/native/yogurt-mac/main.swift) for Windows and
//! Linux, with the same arguments and the same JSON on stdout, so src/main/detectSignals.ts reads either helper.
//!
//!   mic-apps               [{"bundleId","name","pid"}] for each app recording from a microphone now
//!   running-apps ID...     the IDs that have a running process
//!   browser-title ID       {"title": the app's front window title, or null}
//!
//! IDs are the program's file name: "zoom.exe" (lowercased) on Windows, "zoom" or a Flatpak app id on Linux.

// each OS uses its own half of the pure helpers
#[allow(dead_code)]
mod parse;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod win;

#[cfg(target_os = "linux")]
use linux as os;
#[cfg(windows)]
use win as os;

use serde_json::{json, Value};
use std::io::Write;

fn out(v: Value) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{v}");
    let _ = stdout.flush();
}

fn fail(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("mic-apps") => out(parse::apps_json(&os::mic_apps())),
        Some("running-apps") => out(json!(os::running_apps(&args[1..]))),
        Some("browser-title") => {
            if args.len() < 2 {
                fail("browser-title APP_ID")
            }
            out(json!({ "title": os::window_title(&args[1]) }))
        }
        _ => fail("yogurt-system mic-apps | running-apps APP_ID... | browser-title APP_ID"),
    }
}
