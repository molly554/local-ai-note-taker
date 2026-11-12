//! Pure parts of yogurt-system, kept apart from the OS calls so they are tested on every runner.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/** One app on the mic, as `yogurt-mac mic-apps` prints it: {"bundleId","name","pid"} */
#[derive(Debug, Clone, PartialEq)]
pub struct MicApp {
    pub bundle_id: String,
    pub name: String,
    pub pid: u32,
}

/** serde_json sorts keys, like the Mac helper's .sortedKeys */
pub fn apps_json(apps: &[MicApp]) -> Value {
    Value::Array(apps.iter().map(|a| json!({ "bundleId": a.bundle_id, "name": a.name, "pid": a.pid })).collect())
}

/** One line per app process: a process can hold several capture streams at once */
pub fn dedupe(apps: Vec<MicApp>) -> Vec<MicApp> {
    let mut seen = HashSet::new();
    apps.into_iter().filter(|a| seen.insert((a.bundle_id.clone(), a.pid))).collect()
}

// ---- Windows ----

/** The id Windows apps go by: the program's file name, lowercased ("C:\…\Zoom.exe", or ConsentStore's "C:#…#Zoom.exe", is "zoom.exe") */
pub fn exe_id(path: &str) -> String {
    path.rsplit(['\\', '/', '#']).next().unwrap_or(path).to_lowercase()
}

/** "Zoom.exe" reads as "Zoom" */
pub fn exe_name(path: &str) -> String {
    let file = path.rsplit(['\\', '/', '#']).next().unwrap_or(path);
    match file.rsplit_once('.') {
        Some((stem, ext)) if ext.eq_ignore_ascii_case("exe") && !stem.is_empty() => stem.to_string(),
        _ => file.to_string(),
    }
}

/** ConsentStore marks the mic in use from LastUsedTimeStart until it writes LastUsedTimeStop (0 while in use) */
pub fn consent_in_use(start: u64, stop: u64) -> bool {
    start != 0 && stop == 0
}

/** Is this program inside the Store package with this family name? "MSTeams_8wekyb3d8bbwe" lives in "…\WindowsApps\MSTeams_<version>_x64__8wekyb3d8bbwe\" */
pub fn in_package(path: &str, family: &str) -> bool {
    let Some((name, publisher)) = family.rsplit_once('_') else { return false };
    let (start, end) = (format!("{}_", name.to_lowercase()), format!("_{}", publisher.to_lowercase()));
    path.to_lowercase().split(['\\', '/']).any(|dir| dir.len() > start.len() + end.len() && dir.starts_with(&start) && dir.ends_with(&end))
}

#[derive(Debug, Clone)]
pub struct Proc {
    pub exe: String,
    pub parent: u32,
}

/** Processes that capture for another app: new Teams captures in msedgewebview2.exe under ms-teams.exe */
const HOSTS: &[&str] = &["msedgewebview2.exe"];

/** The app a capturing process works for: up the parent chain past web view hosts. Itself when nothing owns it. */
pub fn owner(pid: u32, procs: &HashMap<u32, Proc>) -> u32 {
    let mut cur = pid;
    for _ in 0..16 {
        let Some(p) = procs.get(&cur) else { break };
        if !HOSTS.contains(&exe_id(&p.exe).as_str()) {
            return cur;
        }
        if p.parent == 0 || p.parent == cur {
            break;
        }
        cur = p.parent;
    }
    pid
}

/** Of several processes of one app, the one that started the others (the lowest pid when that is unclear) */
pub fn root_of(hits: &[u32], procs: &HashMap<u32, Proc>) -> Option<u32> {
    let set: HashSet<u32> = hits.iter().copied().collect();
    let mut sorted = hits.to_vec();
    sorted.sort_unstable();
    sorted.iter().copied().find(|pid| procs.get(pid).is_none_or(|p| !set.contains(&p.parent))).or(sorted.first().copied())
}

/** Live capture sessions first; ConsentStore adds apps the sessions missed (exclusive mode, a session Windows did not list) */
pub fn merge(sessions: Vec<MicApp>, consent: Vec<MicApp>) -> Vec<MicApp> {
    let mut out = dedupe(sessions);
    for c in consent {
        if !out.iter().any(|a| a.bundle_id == c.bundle_id) {
            out.push(c);
        }
    }
    out
}

/** The window to read a title from: the active one when it is the app's, else the app's topmost. `windows` is top first. */
pub fn pick_window(windows: &[(u64, bool, String)], active: Option<u64>) -> Option<String> {
    let mine = || windows.iter().filter(|(_, matches, title)| *matches && !title.trim().is_empty());
    mine().find(|(id, _, _)| Some(*id) == active).or_else(|| mine().next()).map(|(_, _, t)| t.clone())
}

// ---- Linux ----

/** A PulseAudio (or PipeWire's pulse server) recording stream, with the properties that name its app */
#[derive(Debug, Clone, Default)]
pub struct Stream {
    pub source: u32,
    pub corked: bool,
    pub props: HashMap<String, String>,
}

/** The Pulse properties read from each stream */
pub const PULSE_KEYS: &[&str] = &[
    "application.process.binary",
    "application.name",
    "application.id",
    "application.process.id",
    "pipewire.access.portal.app_id",
    "pipewire.sec.pid",
];

/** The process id outside any sandbox: PipeWire's socket peer when known (Flatpak apps see their own pid space) */
pub fn stream_pid(s: &Stream) -> u32 {
    let get = |k: &str| s.props.get(k).and_then(|v| v.parse().ok());
    get("pipewire.sec.pid").or_else(|| get("application.process.id")).unwrap_or(0)
}

/**
 * The app behind one recording stream. Its id is the Flatpak app id when sandboxed (portal property, else the
 * process's Flatpak cgroup), else the program's file name, then application.id, then application.name.
 */
pub fn pulse_app(s: &Stream, flatpak: Option<String>) -> Option<MicApp> {
    let get = |k: &str| s.props.get(k).filter(|v| !v.trim().is_empty()).cloned();
    let binary = get("application.process.binary");
    let bundle_id = get("pipewire.access.portal.app_id")
        .or(flatpak)
        .or(binary.clone())
        .or(get("application.id"))
        .or(get("application.name"))?;
    let name = get("application.name").or(binary).unwrap_or(bundle_id.clone());
    Some(MicApp { bundle_id, name, pid: stream_pid(s) })
}

/** Apps on a microphone: running streams, not paused ones, and not ones recording a speaker's monitor (that is sound out, not the mic) */
pub fn pulse_apps(streams: &[Stream], monitors: &HashSet<u32>, flatpak: impl Fn(u32) -> Option<String>) -> Vec<MicApp> {
    dedupe(
        streams
            .iter()
            .filter(|s| !s.corked && !monitors.contains(&s.source))
            .filter_map(|s| {
                let fp = if s.props.contains_key("pipewire.access.portal.app_id") { None } else { flatpak(stream_pid(s)) };
                pulse_app(s, fp)
            })
            .collect(),
    )
}

/** A Flatpak app's id from /proc/<pid>/cgroup: "…/app-flatpak-us.zoom.Zoom-12345.scope" is "us.zoom.Zoom" */
pub fn flatpak_of_cgroup(cgroup: &str) -> Option<String> {
    cgroup.lines().find_map(|line| {
        let unit = line.rsplit('/').next()?.strip_prefix("app-flatpak-")?.strip_suffix(".scope")?;
        let (id, n) = unit.rsplit_once('-')?;
        (!id.is_empty() && n.chars().all(|c| c.is_ascii_digit())).then(|| id.to_string())
    })
}

/** The program name from /proc/<pid>/exe's target ("/opt/google/chrome/chrome (deleted)" after an update is still "chrome") */
pub fn exe_base(target: &str) -> String {
    let t = target.strip_suffix(" (deleted)").unwrap_or(target);
    t.rsplit('/').next().unwrap_or(t).to_string()
}

/** argv[0]'s file name from /proc/<pid>/cmdline */
pub fn argv0_base(cmdline: &[u8]) -> Option<String> {
    let first = cmdline.split(|b| *b == 0).next()?;
    let s = String::from_utf8_lossy(first);
    let base = s.rsplit('/').next()?.to_string();
    (!base.is_empty()).then_some(base)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn procs(list: &[(u32, &str, u32)]) -> HashMap<u32, Proc> {
        list.iter().map(|(pid, exe, parent)| (*pid, Proc { exe: exe.to_string(), parent: *parent })).collect()
    }
    fn app(id: &str, name: &str, pid: u32) -> MicApp {
        MicApp { bundle_id: id.into(), name: name.into(), pid }
    }
    fn stream(props: &[(&str, &str)]) -> Stream {
        Stream { props: props.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), ..Default::default() }
    }

    #[test]
    fn json_matches_the_mac_helper() {
        assert_eq!(apps_json(&[app("zoom.exe", "Zoom", 42)]).to_string(), r#"[{"bundleId":"zoom.exe","name":"Zoom","pid":42}]"#);
        assert_eq!(apps_json(&[]).to_string(), "[]");
    }

    #[test]
    fn windows_ids_are_lowercased_file_names() {
        assert_eq!(exe_id(r"C:\Program Files\Zoom\bin\Zoom.exe"), "zoom.exe");
        assert_eq!(exe_id("C:#Users#me#AppData#Local#Discord#app-1.0.9#Discord.exe"), "discord.exe");
        assert_eq!(exe_id("ms-teams.exe"), "ms-teams.exe");
        assert_eq!(exe_name("C:#Program Files#Zoom#bin#Zoom.exe"), "Zoom");
        assert_eq!(exe_name("weird"), "weird");
    }

    #[test]
    fn consent_store_in_use_until_stop_is_written() {
        assert!(consent_in_use(133_700_000_000_000_000, 0));
        assert!(!consent_in_use(133_700_000_000_000_000, 133_700_000_100_000_000));
        assert!(!consent_in_use(0, 0));
    }

    #[test]
    fn store_packages_match_their_install_folder() {
        let teams = r"C:\Program Files\WindowsApps\MSTeams_25153.1010.3727.5483_x64__8wekyb3d8bbwe\ms-teams.exe";
        assert!(in_package(teams, "MSTeams_8wekyb3d8bbwe"));
        assert!(!in_package(teams, "Microsoft.WindowsCamera_8wekyb3d8bbwe"));
        assert!(!in_package(r"C:\Program Files\Zoom\bin\Zoom.exe", "MSTeams_8wekyb3d8bbwe"));
        assert!(!in_package(teams, "nounderscore"));
    }

    #[test]
    fn web_view_hosts_belong_to_the_app_above_them() {
        let p = procs(&[(10, "explorer.exe", 1), (20, "ms-teams.exe", 10), (30, "msedgewebview2.exe", 20), (31, "msedgewebview2.exe", 30)]);
        assert_eq!(owner(31, &p), 20);
        assert_eq!(owner(20, &p), 20);
        // a host whose parent is gone stays itself
        let orphan = procs(&[(31, "msedgewebview2.exe", 99)]);
        assert_eq!(owner(31, &orphan), 31);
        // a loop in reused pids ends
        let looped = procs(&[(1, "msedgewebview2.exe", 2), (2, "msedgewebview2.exe", 1)]);
        assert_eq!(owner(1, &looped), 1);
        assert_eq!(owner(7, &p), 7);
    }

    #[test]
    fn the_root_process_stands_for_the_app() {
        let p = procs(&[(5, "explorer.exe", 1), (300, "Slack.exe", 5), (120, "Slack.exe", 300), (400, "Slack.exe", 300)]);
        assert_eq!(root_of(&[120, 300, 400], &p), Some(300));
        assert_eq!(root_of(&[], &p), None);
        let cycle = procs(&[(8, "a.exe", 9), (9, "a.exe", 8)]);
        assert_eq!(root_of(&[9, 8], &cycle), Some(8));
    }

    #[test]
    fn sessions_win_over_consent_and_repeats_go() {
        let merged = merge(
            vec![app("zoom.exe", "Zoom", 1), app("zoom.exe", "Zoom", 1), app("chrome.exe", "chrome", 2)],
            vec![app("zoom.exe", "Zoom", 9), app("slack.exe", "slack", 3)],
        );
        assert_eq!(merged, vec![app("zoom.exe", "Zoom", 1), app("chrome.exe", "chrome", 2), app("slack.exe", "slack", 3)]);
    }

    #[test]
    fn titles_come_from_the_active_window_else_the_topmost() {
        let w = vec![(1, false, "Editor".to_string()), (2, true, "".to_string()), (3, true, "Inbox".to_string()), (4, true, "Meet - abc-defg-hij".to_string())];
        assert_eq!(pick_window(&w, Some(4)).as_deref(), Some("Meet - abc-defg-hij"));
        assert_eq!(pick_window(&w, Some(1)).as_deref(), Some("Inbox"));
        assert_eq!(pick_window(&w, None).as_deref(), Some("Inbox"));
        assert_eq!(pick_window(&w[..2], None), None);
    }

    #[test]
    fn pulse_streams_name_their_app() {
        let zoom = stream(&[("application.process.binary", "zoom"), ("application.name", "ZOOM VoiceEngine"), ("application.process.id", "4242")]);
        assert_eq!(pulse_app(&zoom, None), Some(app("zoom", "ZOOM VoiceEngine", 4242)));
        let chrome = stream(&[("application.process.binary", "chrome"), ("application.process.id", "77"), ("pipewire.sec.pid", "78")]);
        assert_eq!(pulse_app(&chrome, None), Some(app("chrome", "chrome", 78)));
        let only_name = stream(&[("application.name", "Some app")]);
        assert_eq!(pulse_app(&only_name, None), Some(app("Some app", "Some app", 0)));
        assert_eq!(pulse_app(&stream(&[]), None), None);
    }

    #[test]
    fn flatpak_apps_go_by_their_app_id() {
        let portal = stream(&[("application.process.binary", "zoom"), ("pipewire.access.portal.app_id", "us.zoom.Zoom"), ("application.process.id", "2")]);
        assert_eq!(pulse_app(&portal, None).unwrap().bundle_id, "us.zoom.Zoom");
        let sandboxed = stream(&[("application.process.binary", "slack"), ("pipewire.sec.pid", "900")]);
        assert_eq!(pulse_app(&sandboxed, Some("com.slack.Slack".into())).unwrap().bundle_id, "com.slack.Slack");
        let cg = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-flatpak-com.discordapp.Discord-48213.scope\n";
        assert_eq!(flatpak_of_cgroup(cg).as_deref(), Some("com.discordapp.Discord"));
        assert_eq!(flatpak_of_cgroup("0::/user.slice/user-1000.slice/session-2.scope\n"), None);
        assert_eq!(flatpak_of_cgroup("0::/app.slice/app-flatpak--.scope"), None);
    }

    #[test]
    fn monitors_and_paused_streams_are_not_the_mic() {
        let mut mic = stream(&[("application.process.binary", "zoom"), ("application.process.id", "1")]);
        mic.source = 3;
        let mut twice = mic.clone();
        twice.source = 4;
        let mut monitor = stream(&[("application.process.binary", "obs"), ("application.process.id", "2")]);
        monitor.source = 9;
        let mut paused = stream(&[("application.process.binary", "discord"), ("application.process.id", "5")]);
        paused.source = 3;
        paused.corked = true;
        let flat = stream(&[("application.process.binary", "slack"), ("application.process.id", "6")]);
        let monitors: HashSet<u32> = [9].into();
        let apps = pulse_apps(&[mic, twice, monitor, paused, flat], &monitors, |pid| (pid == 6).then(|| "com.slack.Slack".to_string()));
        assert_eq!(apps, vec![app("zoom", "zoom", 1), app("com.slack.Slack", "slack", 6)]);
    }

    #[test]
    fn linux_program_names() {
        assert_eq!(exe_base("/opt/google/chrome/chrome (deleted)"), "chrome");
        assert_eq!(exe_base("/usr/bin/zoom"), "zoom");
        assert_eq!(argv0_base(b"/usr/lib/firefox/firefox\0-contentproc\0").as_deref(), Some("firefox"));
        assert_eq!(argv0_base(b""), None);
    }
}
