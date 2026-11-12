//! join and inspect, as the Mac helper does them, for Ogg Opus parts:
//! join stitches me.ogg, me.1.ogg, ... (and them) into one me.ogg and one them.ogg on meeting time (silence in the gaps),
//! keeps every exact input under original/, and removes the part files only after the new file checks out.
use std::fs;
use std::path::{Path, PathBuf};

use crate::oggopus;
use crate::out;
use crate::track::Track;

pub const TRACKS: [&str; 2] = ["me", "them"];

/// Parts of one track, in order: (part number, file, meeting time its file starts at; NaN when part.N.json is missing)
pub fn parts_of(name: &str, dir: &Path) -> Vec<(u32, PathBuf, f64)> {
    let mut out = Vec::new();
    let main = dir.join(format!("{name}.ogg"));
    if main.exists() {
        out.push((0, main, 0.0));
    }
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let f = e.file_name().to_string_lossy().to_string();
            let c: Vec<&str> = f.split('.').collect();
            if c.len() != 3 || c[0] != name || c[2] != "ogg" {
                continue;
            }
            let Ok(n) = c[1].parse::<u32>() else { continue };
            if n == 0 {
                continue;
            }
            let start = fs::read_to_string(dir.join(format!("part.{n}.json"))).ok().and_then(|j| start_ms(&j)).unwrap_or(f64::NAN);
            out.push((n, e.path(), start));
        }
    }
    out.sort_by_key(|p| p.0);
    out
}

/// startMs from part.N.json ({"startMs":X})
pub fn start_ms(json: &str) -> Option<f64> {
    let i = json.find("\"startMs\"")?;
    let rest = json[i + 9..].trim_start().strip_prefix(':')?.trim_start();
    let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == 'e' || c == 'E' || c == '+')).unwrap_or(rest.len());
    rest[..end].parse().ok()
}

fn unique() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let x = t as u64 ^ ((std::process::id() as u64) << 32) ^ N.fetch_add(1, Ordering::SeqCst).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    format!("{:016X}-{:08X}", x, (t >> 64) as u32 ^ N.load(Ordering::SeqCst) as u32)
}

/// A copy of an input under original/, before anything replaces it (a hard link where the disk allows)
fn retain(file: &Path, dir: &Path) -> std::io::Result<()> {
    let originals = dir.join("original");
    fs::create_dir_all(&originals)?;
    let to = originals.join(format!("{}-{}", unique(), file.file_name().unwrap_or_default().to_string_lossy()));
    if fs::hard_link(file, &to).is_err() {
        fs::copy(file, &to)?;
    }
    Ok(())
}

fn duration_ms(p: &Path) -> Option<f64> {
    oggopus::info(p).map(|i| i.duration_ms)
}

/// One file per track on meeting time. Exit code 0 when everything that had parts was joined.
pub fn join(dir: &Path) -> i32 {
    let mut failed = false;
    let mut joined: Vec<u32> = Vec::new();
    for name in TRACKS {
        let parts = parts_of(name, dir);
        if !parts.iter().any(|p| p.0 > 0) {
            continue;
        }
        if !parts.iter().all(|p| p.2.is_finite() && p.2 >= 0.0) {
            out::log("join: missing or invalid part timeline");
            failed = true;
            continue;
        }
        // a join that died after replacing the main file but before removing the parts: the main file already covers
        // every part, so appending them again would repeat audio. Just clean up.
        if parts[0].0 == 0 {
            if let Some(main_end) = duration_ms(&parts[0].1) {
                let covered = parts[1..].iter().all(|p| match duration_ms(&p.1) {
                    Some(d) => p.2 < main_end - 1.0 && p.2 + d <= main_end + 100.0,
                    None => false,
                });
                if covered {
                    let mut ok = true;
                    for p in &parts[1..] {
                        if retain(&p.1, dir).and_then(|_| fs::remove_file(&p.1)).is_err() {
                            ok = false;
                            break;
                        }
                        joined.push(p.0);
                    }
                    if !ok {
                        out::log("join: couldn't retain recovered parts");
                        failed = true;
                    }
                    continue;
                }
            }
        }
        // decode each part and write it into one new file, padding with silence up to where the part starts
        let tmp = dir.join(format!("{name}.joined.ogg"));
        let _ = fs::remove_file(&tmp);
        let mut t = Track::with_file(name, tmp.clone());
        t.stream = false;
        t.open_writer();
        if !t.has_writer() {
            failed = true;
            continue;
        }
        let mut used = 0;
        let mut unreadable = false;
        for (n, file, start) in &parts {
            let target = (start * 48.0) as i64;
            t.pad_to(target);
            if t.pts < target {
                unreadable = true;
                break;
            }
            let mut wrote_all = true;
            let got = oggopus::decode(file, |s| {
                let before = t.pts;
                t.write(s);
                wrote_all = t.pts - before == s.len() as i64;
                wrote_all
            });
            if got.is_none() || !wrote_all {
                out::log(&format!("join: unreadable {} (part {n}); keeping all parts", file.display()));
                unreadable = true;
                break;
            }
            used += 1;
        }
        if unreadable || used == 0 {
            if used == 0 && !unreadable {
                out::log(&format!("join: nothing readable for {name}"));
            }
            failed = true;
            t.cancel();
            continue;
        }
        let pts = t.pts;
        let ok = t.finish();
        let decoded = oggopus::decode(&tmp, |_| true);
        if !ok || decoded.map_or(true, |d| (d as f64 / 48.0 - pts as f64 / 48.0).abs() > 1000.0) {
            out::log(&format!("join: could not write the joined file for {name}"));
            failed = true;
            let _ = fs::remove_file(&tmp);
            continue;
        }
        let main = dir.join(format!("{name}.ogg"));
        // every exact input is kept before anything is replaced
        let kept = parts.iter().try_for_each(|p| retain(&p.1, dir));
        if let Err(e) = kept.and_then(|_| fs::rename(&tmp, &main)) {
            out::log(&format!("join: can't write {}: {e}", main.display()));
            failed = true;
            continue;
        }
        // part.N.json is shared by both tracks, so it goes after the last one
        for p in &parts[..] {
            if p.0 > 0 {
                let _ = fs::remove_file(&p.1);
                joined.push(p.0);
            }
        }
    }
    if !failed {
        for n in joined {
            let _ = fs::remove_file(dir.join(format!("part.{n}.json")));
        }
    }
    if failed {
        1
    } else {
        0
    }
}

/// Read-only append offset: {"durationMs","tracks":{"me":{...}}}. Existing parts must be joined before another session starts.
pub fn inspect(dir: &Path) -> Result<String, String> {
    let mut duration = 0f64;
    let mut tracks = Vec::new();
    for name in TRACKS {
        let parts = parts_of(name, dir);
        if parts.iter().any(|p| p.0 > 0) {
            return Err("inspect: recording still has unjoined parts".into());
        }
        for (_, file, _) in parts {
            let Some(i) = oggopus::info(&file) else { return Err(format!("inspect: unreadable {}", file.file_name().unwrap_or_default().to_string_lossy())) };
            duration = duration.max(i.duration_ms);
            let bps = if i.duration_ms > 0.0 { (i.bytes as f64 * 8.0 / (i.duration_ms / 1000.0)).round() } else { 0.0 };
            // formatID: Core Audio's 'opus'
            tracks.push(format!(
                "{}:{{\"bitsPerSecond\":{},\"channels\":1,\"durationMs\":{},\"formatID\":{},\"sampleRate\":48000}}",
                out::s(name),
                out::n(bps),
                out::n(i.duration_ms),
                0x6f70_7573u32
            ));
        }
    }
    let pending = fs::read_dir(dir).map(|rd| rd.flatten().any(|e| {
        let f = e.file_name().to_string_lossy().to_string();
        f.starts_with("part.") && f.ends_with(".json")
    }));
    if pending.unwrap_or(false) {
        return Err("inspect: recording still has part metadata".into());
    }
    Ok(format!("{{\"durationMs\":{},\"tracks\":{{{}}}}}", duration.ceil() as i64, tracks.join(",")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(dir: &Path, name: &'static str, part: u32, ms: usize, value: f32) {
        let mut t = Track::new(name, dir, part, 0.0);
        t.stream = false;
        t.open_writer();
        let samples: Vec<f32> = (0..ms * 48).map(|i| (i as f32 * 0.05).sin() * value).collect();
        t.write(&samples);
        assert!(t.finish());
    }

    fn rms_between(p: &Path, from_ms: usize, to_ms: usize) -> f64 {
        let mut all = Vec::new();
        oggopus::decode(p, |s| { all.extend_from_slice(s); true }).unwrap();
        let s = &all[from_ms * 48..to_ms * 48];
        (s.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / s.len() as f64).sqrt()
    }

    #[test]
    fn part_json_is_read() {
        assert_eq!(start_ms("{\"startMs\":20000}"), Some(20000.0));
        assert_eq!(start_ms("{\"startMs\": 1234.5 }"), Some(1234.5));
        assert_eq!(start_ms("{}"), None);
    }

    #[test]
    fn parts_join_on_meeting_time_with_silence_between() {
        let dir = crate::testdir("join-parts");
        record(&dir, "me", 0, 1000, 0.3);
        record(&dir, "them", 0, 1000, 0.3);
        record(&dir, "me", 1, 1000, 0.3);
        record(&dir, "them", 1, 500, 0.3);
        fs::write(dir.join("part.1.json"), "{\"startMs\":3000}").unwrap();
        assert!(inspect(&dir).is_err());
        assert_eq!(join(&dir), 0);
        assert!(!dir.join("me.1.ogg").exists());
        assert!(!dir.join("part.1.json").exists());
        assert_eq!(fs::read_dir(dir.join("original")).unwrap().count(), 4);
        assert_eq!(duration_ms(&dir.join("me.ogg")), Some(4000.0));
        assert_eq!(duration_ms(&dir.join("them.ogg")), Some(3500.0));
        let me = dir.join("me.ogg");
        assert!(rms_between(&me, 100, 900) > 0.1);
        assert!(rms_between(&me, 1100, 2900) < 0.01);
        assert!(rms_between(&me, 3100, 3900) > 0.1);
        let j = inspect(&dir).unwrap();
        assert!(j.starts_with("{\"durationMs\":4000,\"tracks\":{\"me\":{"), "{j}");
        // nothing left to join: nothing changes
        assert_eq!(join(&dir), 0);
    }

    #[test]
    fn a_part_without_its_timeline_is_kept() {
        let dir = crate::testdir("join-missing");
        record(&dir, "me", 0, 500, 0.3);
        record(&dir, "me", 1, 500, 0.3);
        assert_eq!(join(&dir), 1);
        assert!(dir.join("me.1.ogg").exists());
    }

    #[test]
    fn a_join_that_died_after_the_swap_only_cleans_up() {
        let dir = crate::testdir("join-recover");
        record(&dir, "me", 0, 4000, 0.3);
        record(&dir, "me", 1, 1000, 0.3);
        fs::write(dir.join("part.1.json"), "{\"startMs\":3000}").unwrap();
        assert_eq!(join(&dir), 0);
        assert_eq!(duration_ms(&dir.join("me.ogg")), Some(4000.0));
        assert!(!dir.join("me.1.ogg").exists());
        assert_eq!(fs::read_dir(dir.join("original")).unwrap().count(), 1);
    }

    #[test]
    fn an_unreadable_part_keeps_everything() {
        let dir = crate::testdir("join-bad");
        record(&dir, "me", 0, 500, 0.3);
        fs::write(dir.join("me.1.ogg"), b"not audio").unwrap();
        fs::write(dir.join("part.1.json"), "{\"startMs\":1000}").unwrap();
        assert_eq!(join(&dir), 1);
        assert!(dir.join("me.1.ogg").exists());
        assert!(dir.join("part.1.json").exists());
        assert!(!dir.join("me.joined.ogg").exists());
    }

    #[test]
    fn inspect_reads_an_empty_folder_as_nothing_recorded() {
        let dir = crate::testdir("inspect-empty");
        assert_eq!(inspect(&dir).unwrap(), "{\"durationMs\":0,\"tracks\":{}}");
    }
}
