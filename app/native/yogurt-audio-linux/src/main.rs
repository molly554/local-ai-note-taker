// Yogurt's recorder on Linux: the microphone and the computer's sound (the default output's monitor) through
// PulseAudio, which PipeWire answers too (pipewire-pulse). No echo cancelling and no voice processing: the call
// app keeps the mic as it is. It speaks exactly what app/native/yogurt-audio (the Mac's) speaks:
//   yogurt-audio record --dir DIR [--part N --start-ms X] [--mic UID] [--speech LOCALE]
//   yogurt-audio join --dir DIR | inspect --dir DIR | compact --dir DIR --out STAGING
//   yogurt-audio speech-locales | speech-install LOCALE | mic-devices
// Files are Ogg Opus (48 kHz mono, 20 kb/s): DIR/me.ogg and DIR/them.ogg, or me.N.ogg and them.N.ogg for part N,
// on meeting time (gaps are silence). stdout: JSON lines; a pcm line is followed by n float32 little-endian samples:
//   {"t":"pcm","track":"me"|"them","ms","n"}   {"t":"level","me","them"} 10 times a second
//   {"t":"warn","code":"no-system-audio"|"device-changed"|"no-mic"|"mic-gone"}   {"t":"mic","uid","name"}
//   {"t":"speech-off"} when --speech was asked for: there is no Apple speech here, whisper reads everything
// stdin: pause, resume, stop (end of input also stops), mic UID or mic auto. A mic's UID is its PulseAudio source name.

mod join;
mod json;
mod ogg_opus;
mod pulse;
mod resample;
mod track;

use json::{n, obj, opt, s, J};
use pulse::{Capture, Change, Snapshot};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use track::Track;

pub fn random_u32() -> u32 {
    let mut b = [0u8; 4];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_err() {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        return t.subsec_nanos() ^ std::process::id();
    }
    u32::from_le_bytes(b)
}
pub fn uuid() -> String {
    let w: Vec<u32> = (0..4).map(|_| random_u32()).collect();
    format!("{:08X}-{:04X}-{:04X}-{:04X}-{:04X}{:08X}", w[0], w[1] >> 16, (w[1] & 0xfff) | 0x4000, (w[2] >> 16 & 0x3fff) | 0x8000, w[2] & 0xffff, w[3])
}

fn fail(msg: &str) -> ! { eprintln!("{msg}"); std::process::exit(1) }

fn arg_value(args: &[String], name: &str) -> Option<String> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).cloned()
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Tr { Me, Them }

enum Msg {
    Audio { track: Tr, gen: u64, samples: Vec<f32>, arrived: f64 },
    Lost { track: Tr, gen: u64 },
    Cmd(String),
    /// stdin closed (Yogurt quit or crashed) or stdout broke (Yogurt gone): keep what we have
    End,
    Server(Change),
}

struct Clock(Instant);
impl Clock { fn ms(&self) -> f64 { self.0.elapsed().as_secs_f64() * 1000.0 } }

struct Recorder {
    me: Track,
    them: Track,
    mic: Option<Capture>,
    sys: Option<Capture>,
    mic_gen: u64,
    sys_gen: u64,
    paused: bool,
    finishing: bool,
    /// the mic the person chose (its source name); None is Auto, the default input, followed as it changes
    mic_uid: Option<String>,
    snap: Arc<Mutex<Snapshot>>,
    tx: Sender<Msg>,
    out: Sender<Vec<u8>>,
    clock: Arc<Clock>,
    mic_rebuild: Option<Instant>,
    sys_rebuild: Option<Instant>,
}

fn line(j: J) -> Vec<u8> { let mut d = j.text().into_bytes(); d.push(b'\n'); d }

impl Recorder {
    fn send(&self, j: J) { let _ = self.out.send(line(j)); }
    fn warn(&self, code: &str) { self.send(obj([("t", s("warn")), ("code", s(code))])) }
    fn snapshot(&self) -> Snapshot { self.snap.lock().unwrap().clone() }
    /// a mic with this name is here now (when the server can't say, trying is the only way to know)
    fn mic_here(&self, uid: &str) -> bool { let s = self.snapshot(); !s.ready || s.mic(uid).is_some() }

    fn start_capture(&mut self, track: Tr, device: Option<String>) -> Option<Capture> {
        let gen = match track { Tr::Me => { self.mic_gen += 1; self.mic_gen }, Tr::Them => { self.sys_gen += 1; self.sys_gen } };
        let (tx, tx2, clock) = (self.tx.clone(), self.tx.clone(), self.clock.clone());
        let name = match track { Tr::Me => "microphone", Tr::Them => "computer sound" };
        pulse::capture(device, name,
            move |samples| { let _ = tx.send(Msg::Audio { track, gen, samples, arrived: clock.ms() }); },
            move || { let _ = tx2.send(Msg::Lost { track, gen }); })
    }

    fn start_mic(&mut self) -> bool {
        if let Some(c) = self.mic.take() { c.stop() }
        let snap = self.snapshot();
        // Auto with no real mic: PulseAudio makes a monitor the default input, which would record the speakers as "me"
        if self.mic_uid.is_none() && snap.ready && snap.default_mic().is_none() { eprintln!("no microphone"); return false }
        self.mic = self.start_capture(Tr::Me, self.mic_uid.clone());
        self.mic.is_some()
    }
    fn start_system(&mut self) -> bool {
        if let Some(c) = self.sys.take() { c.stop() }
        let monitor = self.snapshot().monitor();
        self.sys = self.start_capture(Tr::Them, Some(monitor));
        self.sys.is_some()
    }

    fn start(&mut self, speech: bool) {
        self.me.open_writer();
        self.them.open_writer();
        if speech { eprintln!("speech: this build uses Whisper for live words"); self.send(obj([("t", s("speech-off"))])) }
        // a remembered mic that isn't here today: Auto, quietly (nothing was lost mid-meeting)
        if let Some(uid) = self.mic_uid.clone() { if !self.mic_here(&uid) { eprintln!("the chosen microphone isn't here: using the default"); self.mic_uid = None } }
        if !self.start_mic() {
            if self.mic_uid.is_some() {
                eprintln!("couldn't choose the microphone: using the default");
                self.mic_uid = None;
                if !self.start_mic() { eprintln!("recording without the microphone") }
            } else { eprintln!("recording without the microphone") }
        }
        self.report_mic();
        if !self.start_system() { self.warn("no-system-audio") }
    }

    fn report_mic(&self) {
        let snap = self.snapshot();
        let dev = match &self.mic_uid { Some(u) => snap.mic(u), None => snap.default_mic() };
        self.send(obj([("t", s("mic")), ("uid", opt(self.mic_uid.as_deref())), ("name", opt(dev.map(|d| d.description.as_str())))]));
    }

    // device changes come in bursts; rebuild once they settle, without stopping the recording
    fn schedule_mic(&mut self, after_ms: u64) { self.mic_rebuild = Some(Instant::now() + Duration::from_millis(after_ms)) }
    fn schedule_sys(&mut self) { self.sys_rebuild = Some(Instant::now() + Duration::from_millis(300)) }

    fn rebuild_system(&mut self) {
        if self.finishing { return }
        self.them.resync();
        if !self.start_system() { self.warn("no-system-audio") }
        self.warn("device-changed");
    }
    /// A new stream on the chosen mic (or the default). The time in between is silence in me.ogg.
    fn rebuild_mic(&mut self) {
        if self.finishing { return }
        if let Some(uid) = self.mic_uid.clone() {
            if !self.mic_here(&uid) { eprintln!("the chosen microphone went away: using the default"); self.mic_uid = None; self.warn("mic-gone") }
        }
        self.me.resync();
        if !self.start_mic() {
            // the chosen mic can't be recorded from: Auto, and the picker is told
            if self.mic_uid.is_some() { self.mic_uid = None; self.warn("mic-gone"); if !self.start_mic() { eprintln!("microphone lost") } }
            else { eprintln!("microphone lost") }
        }
        self.warn("device-changed");
        self.report_mic();
    }
    /// mic UID, or mic auto: switch now, without stopping the recording. An unknown mic changes nothing.
    fn choose_mic(&mut self, arg: &str) {
        let uid = if arg == "auto" { None } else { Some(arg.to_string()) };
        if let Some(u) = &uid { if !self.mic_here(u) { eprintln!("no microphone {u} here"); self.report_mic(); return } }
        if uid == self.mic_uid && self.mic.is_some() { self.report_mic(); return }
        self.mic_uid = uid;
        self.me.resync();
        if self.start_mic() { self.warn("device-changed"); self.report_mic(); return }
        eprintln!("moving the microphone failed: building it again");
        self.schedule_mic(0);
    }

    fn command(&mut self, c: &str) {
        match c {
            "pause" => { self.paused = true; self.me.flush_pending(); self.them.flush_pending() }
            "resume" => { self.paused = false; self.me.resync(); self.them.resync() }
            "stop" => self.finish(),
            _ if c.starts_with("mic ") => { let a = c[4..].trim().to_string(); self.choose_mic(&a) }
            _ => eprintln!("unknown command: {c}"),
        }
    }

    fn handle(&mut self, m: Msg) {
        match m {
            Msg::Audio { track, gen, samples, arrived } => {
                if self.paused || self.finishing { return }
                match track {
                    Tr::Me if gen == self.mic_gen && self.mic.is_some() => self.me.append(&samples, None, arrived),
                    // the speakers' stream says when it heard each buffer: the time it arrived, less its length
                    Tr::Them if gen == self.sys_gen && self.sys.is_some() => self.them.append(&samples, Some(arrived - samples.len() as f64 / 48.0), arrived),
                    _ => {}
                }
            }
            Msg::Lost { track: Tr::Me, gen } if gen == self.mic_gen => { self.mic = None; self.schedule_mic(300) }
            Msg::Lost { track: Tr::Them, gen } if gen == self.sys_gen => { self.sys = None; self.schedule_sys() }
            Msg::Lost { .. } => {}
            Msg::Cmd(c) => self.command(&c),
            Msg::End => self.finish(),
            Msg::Server(Change::Sink) => self.schedule_sys(),
            // Auto follows the default input; a chosen mic stays put
            Msg::Server(Change::Source) => if self.mic_uid.is_none() { self.schedule_mic(300) },
            // a chosen mic unplugged: back to Auto
            Msg::Server(Change::Sources) => {
                if let Some(u) = self.mic_uid.clone() { if self.snapshot().mic(&u).is_none() { self.schedule_mic(300) } }
                else if self.mic.is_none() && self.snapshot().default_mic().is_some() { self.schedule_mic(300) }
            }
        }
    }

    fn finish(&mut self) {
        if self.finishing { return }
        self.finishing = true;
        if let Some(c) = self.mic.take() { c.stop() }
        if let Some(c) = self.sys.take() { c.stop() }
        self.me.flush_pending();
        self.them.flush_pending();
        // both files end together, so they stay the same length
        let end = self.me.pts.max(self.them.pts);
        self.me.pad_to(end);
        self.them.pad_to(end);
        self.me.finish();
        self.them.finish();
    }

    fn run(&mut self, rx: Receiver<Msg>) {
        let mut next_level = Instant::now() + Duration::from_millis(100);
        while !self.finishing {
            let mut wake = next_level;
            for d in [self.mic_rebuild, self.sys_rebuild].into_iter().flatten() { wake = wake.min(d) }
            let wait = wake.saturating_duration_since(Instant::now());
            match rx.recv_timeout(wait) {
                Ok(m) => self.handle(m),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => self.finish(),
            }
            if self.finishing { break }
            let now = Instant::now();
            if self.sys_rebuild.is_some_and(|d| d <= now) { self.sys_rebuild = None; self.rebuild_system() }
            if self.mic_rebuild.is_some_and(|d| d <= now) { self.mic_rebuild = None; self.rebuild_mic() }
            if now >= next_level {
                next_level += Duration::from_millis(100);
                if next_level < now { next_level = now + Duration::from_millis(100) }
                let (me, them) = if self.paused { (0.0, 0.0) } else { (self.me.level(), self.them.level()) };
                self.send(obj([("t", s("level")), ("me", n(me)), ("them", n(them))]));
            }
        }
    }
}

/// stdout on its own thread, so a slow reader never holds up the audio; a broken pipe finishes the files
fn output(work: Sender<Msg>) -> (Sender<Vec<u8>>, std::thread::JoinHandle<()>) {
    let (tx, rx) = channel::<Vec<u8>>();
    let h = std::thread::spawn(move || {
        let mut out = std::io::stdout().lock();
        let mut gone = false;
        for d in rx {
            if gone { continue }
            if out.write_all(&d).and_then(|_| out.flush()).is_err() { gone = true; let _ = work.send(Msg::End); }
        }
    });
    (tx, h)
}

fn mic_devices() {
    let snap = Arc::new(Mutex::new(Snapshot::default()));
    pulse::watch(snap.clone(), |_| {});
    let s = snap.lock().unwrap().clone();
    let def = s.default_mic().map(|m| m.name.clone());
    let list: Vec<J> = s.mics().map(|m| obj([("uid", json::s(&m.name)), ("name", json::s(&m.description)), ("default", J::Bool(Some(&m.name) == def.as_ref()))])).collect();
    println!("{}", obj([("devices", J::Arr(list))]).text());
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let sub = args.get(1).map(|s| s.as_str()).unwrap_or("");
    match sub {
        // no Apple speech off the Mac: whisper does all the reading
        "speech-locales" => { println!(r#"{{"available":false,"supported":[],"installed":[]}}"#); return }
        "speech-install" => { println!(r#"{{"installed":false}}"#); return }
        "mic-devices" => { mic_devices(); return }
        _ => {}
    }
    let dir_arg = arg_value(&args, "--dir");
    if args.len() < 4 || !matches!(sub, "record" | "join" | "inspect" | "compact") || dir_arg.is_none() {
        fail("usage: yogurt-audio record --dir DIR [--part N --start-ms X] [--mic UID] [--speech LOCALE] | join --dir DIR | inspect --dir DIR | compact --dir DIR --out STAGING | speech-locales | speech-install LOCALE | mic-devices");
    }
    let dir = PathBuf::from(dir_arg.unwrap());
    match sub {
        "inspect" => match join::inspect(&dir) { Ok(j) => { println!("{j}"); return } Err(e) => fail(&e) },
        // Ogg Opus at 20 kb/s is already compact: nothing to convert (the Mac's legacy AAC migration)
        "compact" => { if arg_value(&args, "--out").is_none() { fail("compact: --out is required") } println!("null"); return }
        _ => {}
    }
    let _ = std::fs::create_dir_all(&dir);
    if sub == "join" { std::process::exit(join::join_parts(&dir)) }
    record(&args, &dir);
}

fn record(args: &[String], dir: &Path) {
    let part: u32 = arg_value(args, "--part").and_then(|v| v.parse().ok()).unwrap_or(0);
    let start_ms: f64 = arg_value(args, "--start-ms").and_then(|v| v.parse().ok()).unwrap_or(0.0);
    if part > 0 {
        // so join knows where on meeting time this part's files start
        let _ = std::fs::write(dir.join(format!("part.{part}.json")), obj([("startMs", n(start_ms))]).text());
    }
    let clock = Arc::new(Clock(Instant::now()));
    let (tx, rx) = channel::<Msg>();
    let (out, out_thread) = output(tx.clone());
    let snap = Arc::new(Mutex::new(Snapshot::default()));
    let tx_server = Mutex::new(tx.clone());
    pulse::watch(snap.clone(), move |c| { let _ = tx_server.lock().unwrap().send(Msg::Server(c)); });

    let (o1, o2) = (out.clone(), out.clone());
    let mut rec = Recorder {
        me: Track::new("me", dir, part, start_ms, Box::new(move |d| { let _ = o1.send(d); })),
        them: Track::new("them", dir, part, start_ms, Box::new(move |d| { let _ = o2.send(d); })),
        mic: None, sys: None, mic_gen: 0, sys_gen: 0, paused: false, finishing: false,
        mic_uid: arg_value(args, "--mic"), snap, tx: tx.clone(), out, clock,
        mic_rebuild: None, sys_rebuild: None,
    };
    rec.start(arg_value(args, "--speech").is_some());

    let tx_in = tx.clone();
    std::thread::spawn(move || {
        for l in std::io::stdin().lock().lines() {
            let Ok(l) = l else { break };
            let c = l.trim();
            if !c.is_empty() && tx_in.send(Msg::Cmd(c.to_string())).is_err() { return }
        }
        let _ = tx_in.send(Msg::End);
    });
    drop(tx);
    rec.run(rx);
    // every line out before leaving
    drop(rec);
    let _ = out_thread.join();
    std::process::exit(0);
}
