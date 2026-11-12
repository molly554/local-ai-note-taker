// Yogurt's recorder on Windows, speaking the same protocol as the Mac's (native/yogurt-audio/main.swift): the microphone
// (WASAPI shared mode, no communications role, so the call app keeps its mic as it was) and the computer's sound
// (process loopback on every app except Yogurt, Windows 10 2004+; the whole output where that can't start).
//   yogurt-audio record --dir DIR [--part N --start-ms X] [--mic ID] [--speech LOCALE]
//   yogurt-audio join --dir DIR | inspect --dir DIR | mic-devices | speech-locales | speech-install LOCALE
// Writes DIR/me.ogg and DIR/them.ogg (Opus 20 kb/s mono, 48 kHz), a page a second so a crash keeps what was recorded.
// A restart after a crash is part N: DIR/me.N.ogg and DIR/them.N.ogg, whose file time starts at X; join stitches them.
// File time is meeting time on both: gaps (startup, pause, device switches) are written as silence.
// stdout: JSON lines; a pcm line is followed by n float32 little-endian samples (16 kHz mono).
//   {"t":"pcm","track":"me"|"them","ms":<startMs>,"n":<samples>}
//   {"t":"level","me":0..1,"them":0..1}        10 times a second
//   {"t":"warn","code":"no-system-audio"|"device-changed"|"no-mic"|"mic-gone"}
//   {"t":"mic","uid":string|null,"name":string|null}   the mic recording now, after each start: uid null is Auto
//   {"t":"speech-off"}   for --speech: Apple's speech is Mac only, Whisper gives the live words
// stdin: pause, resume, stop (end of input also stops), mic ID or mic auto (switch without stopping). Problems go to stderr.
mod gap;
mod join;
mod ogg;
mod oggopus;
mod opus;
mod out;
#[cfg(windows)]
mod record;
mod resample;
mod track;
mod wav;
#[cfg(windows)]
mod win;

use std::path::{Path, PathBuf};

use out::fail;

fn arg_value(args: &[String], name: &str) -> Option<String> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).cloned()
}

fn testing() -> bool {
    std::env::var("YOGURT_AUDIO_TEST").as_deref() == Ok("1")
}

const USAGE: &str = "usage: yogurt-audio record --dir DIR [--part N --start-ms X] [--mic ID] [--speech LOCALE] | join --dir DIR | inspect --dir DIR | compact --dir DIR --out STAGING | mic-devices | speech-locales | speech-install LOCALE";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("");
    match cmd {
        // Apple's on-device speech is Mac only: nothing to offer here
        "speech-locales" => println!("{{\"available\":false,\"supported\":[],\"installed\":[]}}"),
        "speech-install" => println!("{{\"installed\":false}}"),
        "mic-devices" => mic_devices(),
        "writer-probe" => writer_probe(&args),
        "record" | "join" | "inspect" | "compact" if args.len() >= 4 => {
            let Some(dir) = arg_value(&args, "--dir") else { fail(USAGE) };
            let dir = PathBuf::from(dir);
            match cmd {
                "inspect" => match join::inspect(&dir) {
                    Ok(j) => println!("{j}"),
                    Err(e) => fail(&e),
                },
                // Ogg Opus at 20 kb/s is already compact
                "compact" => println!("null"),
                "join" => {
                    let _ = std::fs::create_dir_all(&dir);
                    std::process::exit(join::join(&dir))
                }
                _ => record(&args, &dir),
            }
        }
        _ => fail(USAGE),
    }
}

fn record(args: &[String], dir: &Path) {
    let _ = std::fs::create_dir_all(dir);
    let part: u32 = arg_value(args, "--part").and_then(|v| v.parse().ok()).unwrap_or(0);
    let start_ms: f64 = arg_value(args, "--start-ms").and_then(|v| v.parse().ok()).unwrap_or(0.0);
    if part > 0 {
        // so join knows where on meeting time this part's files start
        let _ = std::fs::write(dir.join(format!("part.{part}.json")), format!("{{\"startMs\":{}}}", out::n(start_ms)));
    }
    #[cfg(windows)]
    {
        let o = record::Options { part, start_ms, mic: arg_value(args, "--mic"), speech: arg_value(args, "--speech").is_some() };
        std::process::exit(record::run(dir, o));
    }
    #[cfg(not(windows))]
    fail("record: this build is for Windows");
}

fn mic_devices() {
    #[cfg(windows)]
    {
        win::com();
        let list: Vec<String> = win::mic_devices()
            .iter()
            .map(|(uid, name, d)| format!("{{\"default\":{},\"name\":{},\"uid\":{}}}", d, out::s(name), out::s(uid)))
            .collect();
        println!("{{\"devices\":[{}]}}", list.join(","));
    }
    #[cfg(not(windows))]
    println!("{{\"devices\":[]}}");
}

/// CI only: committed audio through the real recording Track in 100 ms chunks, no devices. Without "finish" on stdin
/// the files are left as a crash leaves them.
fn writer_probe(args: &[String]) {
    let (Some(output), Some(me), Some(them)) = (arg_value(args, "--dir"), arg_value(args, "--me"), arg_value(args, "--them")) else {
        fail("writer-probe requires YOGURT_AUDIO_TEST=1 and fixture paths")
    };
    if !testing() {
        fail("writer-probe requires YOGURT_AUDIO_TEST=1 and fixture paths");
    }
    let dir = PathBuf::from(output);
    let _ = std::fs::create_dir_all(&dir);
    let mut tracks = Vec::new();
    let mut input_ms: f64 = 0.0;
    for (name, path) in [("me", me), ("them", them)] {
        let target = dir.join(format!("{name}.ogg"));
        let wav = std::fs::read(&path).ok().and_then(|b| wav::read(&b));
        let Some((samples, rate)) = wav else { fail("writer-probe requires new output and a short readable fixture") };
        let s48 = match rate {
            48_000 => samples,
            16_000 => resample::up3(&samples),
            _ => fail("writer-probe fixtures are 16 or 48 kHz"),
        };
        if target.exists() || s48.len() > 48_000 * 60 {
            fail("writer-probe requires new output and a short readable fixture");
        }
        input_ms = input_ms.max(s48.len() as f64 / 48.0);
        let mut t = track::Track::new(name, &dir, 0, 0.0);
        t.stream = false;
        t.open_writer();
        if !t.has_writer() {
            fail("writer-probe could not open writer");
        }
        tracks.push((t, s48));
    }
    for (t, s) in &mut tracks {
        for (i, c) in s.chunks(4800).enumerate() {
            t.append(c, Some(i as f64 * 100.0), i as f64 * 100.0 + 100.0);
        }
    }
    out::send(&format!("{{\"fragmentMs\":1000,\"inputMs\":{},\"t\":\"writer-fed\"}}", out::n(input_ms)), None);
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
    if line.trim() == "finish" {
        for (t, _) in &mut tracks {
            t.finish();
        }
    } else {
        // as a crash leaves them: no last page
        std::process::exit(0);
    }
}

/// A fresh folder for one test
#[cfg(test)]
pub fn testdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join("yogurt-audio-tests").join(format!("{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}
