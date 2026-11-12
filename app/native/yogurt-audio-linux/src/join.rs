//! join and inspect, as the Mac helper does them, on Ogg Opus files:
//! join stitches me.ogg, me.1.ogg, ... (and them) into one me.ogg and one them.ogg on meeting time (silence in the gaps),
//! keeps every original in original/ and removes the part files only after the new file checked out.

use crate::json::{n, J};
use crate::ogg_opus::{self, RATE};
use crate::track::Track;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const EXT: &str = "ogg";

/// Parts of one track, in order: (part number, file, meeting time its file starts at; NaN if unknown)
pub fn parts_of(name: &str, dir: &Path) -> Vec<(u32, PathBuf, f64)> {
    let mut out = Vec::new();
    let main = dir.join(format!("{name}.{EXT}"));
    if main.exists() { out.push((0, main, 0.0)) }
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let f = e.file_name().to_string_lossy().to_string();
        let c: Vec<&str> = f.split('.').collect();
        if c.len() != 3 || c[0] != name || c[2] != EXT { continue }
        let Ok(k) = c[1].parse::<u32>() else { continue };
        if k == 0 { continue }
        let start = fs::read_to_string(dir.join(format!("part.{k}.json"))).ok()
            .and_then(|t| crate::json::number_field(&t, "startMs")).unwrap_or(f64::NAN);
        out.push((k, dir.join(&f), start));
    }
    out.sort_by_key(|p| p.0);
    out
}

fn seconds(p: &Path) -> Option<f64> { ogg_opus::info(p).ok().map(|i| i.samples as f64 / RATE as f64) }

fn retain(file: &Path, dir: &Path) -> io::Result<()> {
    let originals = dir.join("original");
    fs::create_dir_all(&originals)?;
    let base = file.file_name().unwrap().to_string_lossy();
    fs::hard_link(file, originals.join(format!("{}-{base}", crate::uuid())))
}

/// One file per track on meeting time. 0 when everything that had parts was joined.
pub fn join_parts(dir: &Path) -> i32 {
    let mut failed = false;
    let mut joined: Vec<u32> = Vec::new();
    for name in ["me", "them"] {
        let parts = parts_of(name, dir);
        if !parts.iter().any(|p| p.0 > 0) { continue }
        if !parts.iter().all(|p| p.2.is_finite() && p.2 >= 0.0) { eprintln!("join: missing or invalid part timeline"); failed = true; continue }
        // a join that died after replacing the main file but before removing the parts: the main file already covers
        // every part, so appending them again would repeat audio. Just clean up.
        if parts[0].0 == 0 {
            if let Some(main_end) = seconds(&parts[0].1) {
                let covered = parts[1..].iter().all(|p| match seconds(&p.1) {
                    Some(d) => p.2 / 1000.0 < main_end - 0.001 && p.2 / 1000.0 + d <= main_end + 0.1,
                    None => false,
                });
                if covered {
                    let r: io::Result<()> = (|| {
                        for p in &parts[1..] { retain(&p.1, dir)? }
                        for p in &parts[1..] { fs::remove_file(&p.1)?; joined.push(p.0) }
                        Ok(())
                    })();
                    if let Err(e) = r { eprintln!("join: couldn't retain recovered parts: {e}"); failed = true }
                    continue;
                }
            }
        }
        // decode each part and write it into one new file, with silence up to where each part starts
        let tmp = dir.join(format!("{name}.joined.{EXT}"));
        let _ = fs::remove_file(&tmp);
        let mut out = Track::file(name, tmp.clone());
        if !out.open_writer() { failed = true; continue }
        let (mut used, mut unreadable) = (0, false);
        for (k, url, start_ms) in &parts {
            let target = (start_ms * 48.0) as u64;
            out.pad_to(target);
            if out.pts < target { unreadable = true; break }
            let r = ogg_opus::decode(url, |s| {
                let before = out.pts;
                out.write(s);
                if out.pts - before != s.len() as u64 { return Err(io::Error::new(io::ErrorKind::Other, "write failed")) }
                Ok(())
            });
            if let Err(e) = r { eprintln!("join: unreadable part {k} ({}): {e}; keeping all parts", url.display()); unreadable = true; break }
            used += 1;
        }
        if unreadable { failed = true; out.cancel(); continue }
        if used == 0 { eprintln!("join: nothing readable for {name}"); failed = true; out.cancel(); continue }
        let written = out.pts;
        let finished = out.finish();
        let decoded = ogg_opus::decode(&tmp, |_| Ok(())).ok();
        let ok = finished && decoded.map(|d| (d as f64 - written as f64).abs() / 48.0 <= 1000.0).unwrap_or(false);
        if !ok { eprintln!("join: could not write the joined file for {name}"); failed = true; let _ = fs::remove_file(&tmp); continue }
        let main = dir.join(format!("{name}.{EXT}"));
        let r: io::Result<()> = (|| {
            // every exact input is kept before anything is replaced
            for p in &parts { retain(&p.1, dir)? }
            fs::rename(&tmp, &main)
        })();
        if let Err(e) = r { eprintln!("join: can't write {}: {e}", main.display()); failed = true; continue }
        // part.N.json is shared by both tracks, so it goes after the last one
        for p in &parts { if p.0 > 0 { let _ = fs::remove_file(&p.1); joined.push(p.0) } }
    }
    if !failed { for k in joined { let _ = fs::remove_file(dir.join(format!("part.{k}.json"))); } }
    if failed { 1 } else { 0 }
}

/// Read-only append offset: {"durationMs","tracks":{me,them}}. Err when parts are still unjoined or a file can't be read.
pub fn inspect(dir: &Path) -> Result<String, String> {
    let mut duration = 0f64;
    let mut tracks = BTreeMap::new();
    for name in ["me", "them"] {
        let parts = parts_of(name, dir);
        if parts.iter().any(|p| p.0 > 0) { return Err("inspect: recording still has unjoined parts".into()) }
        for (_, url, _) in parts {
            let Ok(i) = ogg_opus::info(&url) else { return Err(format!("inspect: unreadable {}", url.file_name().unwrap().to_string_lossy())) };
            let ms = i.samples as f64 / 48.0;
            duration = duration.max(ms);
            let bps = if ms > 0.0 { (i.bytes as f64 * 8.0 / (ms / 1000.0)).round() } else { 0.0 };
            // formatID: Core Audio's code for Opus ('opus'), so the fields mean what they mean on a Mac
            tracks.insert(name.to_string(), crate::json::obj([("formatID", n(0x6f707573 as f64)), ("sampleRate", n(RATE as f64)),
                ("channels", n(i.channels as f64)), ("bitsPerSecond", n(bps)), ("durationMs", n(ms))]));
        }
    }
    let meta = fs::read_dir(dir).into_iter().flatten().flatten()
        .any(|e| { let f = e.file_name().to_string_lossy().to_string(); f.starts_with("part.") && f.ends_with(".json") });
    if meta { return Err("inspect: recording still has part metadata".into()) }
    Ok(crate::json::obj([("durationMs", n(duration.ceil())), ("tracks", J::Obj(tracks))]).text())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ogg_opus::OpusWriter;

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("yogurt-join-{}-{}", std::process::id(), crate::random_u32()));
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn write(p: &Path, ms: u64, v: f32) {
        let mut w = OpusWriter::create(p).unwrap();
        w.write(&vec![v; (ms * 48) as usize]).unwrap();
        w.finish().unwrap();
    }
    fn dur(p: &Path) -> f64 { ogg_opus::info(p).unwrap().samples as f64 / 48.0 }

    #[test]
    fn stitches_parts_on_meeting_time() {
        let d = dir();
        for t in ["me", "them"] { write(&d.join(format!("{t}.ogg")), 2000, 0.0); write(&d.join(format!("{t}.1.ogg")), 1500, 0.0) }
        // the restart came 3 s in: a second of silence between the parts
        fs::write(d.join("part.1.json"), r#"{"startMs":3000}"#).unwrap();
        assert!(inspect(&d).unwrap_err().contains("unjoined parts"));
        assert_eq!(join_parts(&d), 0);
        for t in ["me", "them"] {
            assert_eq!(dur(&d.join(format!("{t}.ogg"))), 4500.0);
            assert!(!d.join(format!("{t}.1.ogg")).exists());
        }
        assert!(!d.join("part.1.json").exists());
        assert_eq!(fs::read_dir(d.join("original")).unwrap().count(), 4);
        let j = inspect(&d).unwrap();
        assert!(j.starts_with(r#"{"durationMs":4500,"tracks":{"me":{"bitsPerSecond":"#), "{j}");
        assert!(j.contains(r#""channels":1,"durationMs":4500,"formatID":1869641075,"sampleRate":48000"#), "{j}");
        // nothing left to join
        assert_eq!(join_parts(&d), 0);
    }

    #[test]
    fn a_part_without_its_start_is_left_alone() {
        let d = dir();
        write(&d.join("me.ogg"), 1000, 0.0);
        write(&d.join("me.1.ogg"), 1000, 0.0);
        assert_eq!(join_parts(&d), 1);
        assert!(d.join("me.1.ogg").exists());
        assert_eq!(dur(&d.join("me.ogg")), 1000.0);
    }

    #[test]
    fn an_unreadable_part_keeps_everything() {
        let d = dir();
        write(&d.join("me.ogg"), 1000, 0.0);
        fs::write(d.join("me.1.ogg"), b"broken").unwrap();
        fs::write(d.join("part.1.json"), r#"{"startMs":1000}"#).unwrap();
        assert_eq!(join_parts(&d), 1);
        assert!(d.join("me.1.ogg").exists() && d.join("part.1.json").exists());
        assert!(!d.join("me.joined.ogg").exists());
        assert_eq!(dur(&d.join("me.ogg")), 1000.0);
    }

    #[test]
    fn a_join_that_died_after_the_swap_only_cleans_up() {
        let d = dir();
        // the main file already holds both parts
        write(&d.join("me.ogg"), 3000, 0.0);
        write(&d.join("me.1.ogg"), 1000, 0.0);
        fs::write(d.join("part.1.json"), r#"{"startMs":2000}"#).unwrap();
        assert_eq!(join_parts(&d), 0);
        assert_eq!(dur(&d.join("me.ogg")), 3000.0);
        assert!(!d.join("me.1.ogg").exists() && !d.join("part.1.json").exists());
        assert_eq!(fs::read_dir(d.join("original")).unwrap().count(), 1);
    }

    #[test]
    fn inspect_an_empty_folder_and_a_bad_file() {
        let d = dir();
        assert_eq!(inspect(&d).unwrap(), r#"{"durationMs":0,"tracks":{}}"#);
        fs::write(d.join("them.ogg"), b"nope").unwrap();
        assert_eq!(inspect(&d).unwrap_err(), "inspect: unreadable them.ogg");
    }
}
