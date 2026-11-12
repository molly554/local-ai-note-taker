//! record: both tracks until stop (or end of input). All audio work happens on one thread, so tracks, pause and
//! rebuilds never race (the Mac helper's work queue).
use std::path::Path;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::{Duration, Instant};

use crate::out::{self, log};
use crate::track::Track;
use crate::win::{self, Clock, Ev, StartError, Stream};

/// device changes come in bursts; rebuild once they settle
const SETTLE: Duration = Duration::from_millis(300);

pub struct Options {
    pub part: u32,
    pub start_ms: f64,
    pub mic: Option<String>,
    pub speech: bool,
}

struct Recorder {
    me: Track,
    them: Track,
    mic: Option<Stream>,
    sys: Option<Stream>,
    paused: bool,
    /// the microphone the person chose (its ID); None is Auto, Windows' default input, followed as it changes
    mic_uid: Option<String>,
    mic_rebuild: Option<Instant>,
    sys_rebuild: Option<Instant>,
    tx: std::sync::mpsc::Sender<Ev>,
    clock: Clock,
}

pub fn run(dir: &Path, o: Options) -> i32 {
    win::com();
    let clock = Clock::new();
    let (tx, rx) = channel::<Ev>();
    let mut r = Recorder {
        me: Track::new("me", dir, o.part, o.start_ms),
        them: Track::new("them", dir, o.part, o.start_ms),
        mic: None,
        sys: None,
        paused: false,
        mic_uid: o.mic,
        mic_rebuild: None,
        sys_rebuild: None,
        tx: tx.clone(),
        clock,
    };
    r.start(o.speech);
    let _watch = win::watch(tx.clone());
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut line = String::new();
            loop {
                line.clear();
                match std::io::stdin().read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let c = line.trim();
                        if !c.is_empty() {
                            let _ = tx.send(Ev::Cmd(c.to_string()));
                        }
                    }
                }
            }
            // Yogurt closed the pipe (quit or crashed): keep what we have
            let _ = tx.send(Ev::Eof);
        });
    }
    let tick = Duration::from_millis(100);
    let mut next_level = Instant::now() + tick;
    loop {
        let now = Instant::now();
        let mut due = next_level;
        for d in [r.mic_rebuild, r.sys_rebuild].into_iter().flatten() {
            due = due.min(d);
        }
        match rx.recv_timeout(due.saturating_duration_since(now)) {
            Ok(Ev::Mic(b)) => {
                if !r.paused {
                    r.me.append(&b, None, r.clock.now_ms())
                }
            }
            Ok(Ev::Sys(b, heard)) => {
                if !r.paused {
                    r.them.append(&b, Some(heard), r.clock.now_ms())
                }
            }
            Ok(Ev::MicLost) => r.schedule_mic(SETTLE),
            Ok(Ev::SysLost) => r.sys_rebuild = Some(Instant::now() + SETTLE),
            Ok(Ev::Default(true)) => r.sys_rebuild = Some(Instant::now() + SETTLE),
            // Auto follows Windows' input; a chosen mic stays put
            Ok(Ev::Default(false)) => {
                if r.mic_uid.is_none() {
                    r.schedule_mic(SETTLE)
                }
            }
            // a chosen mic unplugged: back to Auto
            Ok(Ev::Devices) => {
                if let Some(uid) = &r.mic_uid {
                    if win::mic_device(uid).is_none() {
                        r.schedule_mic(SETTLE)
                    }
                }
            }
            Ok(Ev::Cmd(c)) => {
                if r.command(&c) {
                    break;
                }
            }
            Ok(Ev::Eof) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
        if out::broken() {
            break;
        }
        let now = Instant::now();
        if r.mic_rebuild.is_some_and(|d| d <= now) {
            r.mic_rebuild = None;
            r.rebuild_mic();
        }
        if r.sys_rebuild.is_some_and(|d| d <= now) {
            r.sys_rebuild = None;
            r.rebuild_system();
        }
        if now >= next_level {
            next_level = now + tick;
            let (me, them) = if r.paused { (0.0, 0.0) } else { (r.me.level(), r.them.level()) };
            out::level(me, them);
        }
    }
    r.finish();
    0
}

impl Recorder {
    fn start(&mut self, speech: bool) {
        self.me.open_writer();
        self.them.open_writer();
        if speech {
            log("speech: this build uses Whisper for live words");
            out::send("{\"t\":\"speech-off\"}", None);
        }
        // a remembered mic that isn't here today: Auto, quietly (nothing was lost mid-meeting)
        if let Some(uid) = &self.mic_uid {
            if win::mic_device(uid).is_none() {
                log("the chosen microphone isn't here: using the computer's");
                self.mic_uid = None;
            }
        }
        self.start_mic(false);
        self.report_mic();
        self.start_system();
    }

    /// The chosen mic, else the default; false when neither records. gone: tell the picker when the chosen one failed
    fn start_mic(&mut self, gone: bool) -> bool {
        match win::start_mic(self.mic_uid.clone(), self.tx.clone()) {
            Ok(s) => {
                self.mic = Some(s);
                return true;
            }
            Err(StartError::Denied) => {
                log("no microphone access: allow it in Settings, Privacy & security, Microphone (Let desktop apps access your microphone)");
                out::warn("no-mic");
                return false;
            }
            Err(e) => log(&format!("microphone failed: {e:?}")),
        }
        if self.mic_uid.is_some() {
            // the chosen mic can't be recorded from: Auto, and the picker is told
            self.mic_uid = None;
            if gone {
                out::warn("mic-gone");
            }
            if let Ok(s) = win::start_mic(None, self.tx.clone()) {
                self.mic = Some(s);
                return true;
            }
        }
        log("recording without the microphone");
        false
    }

    fn start_system(&mut self) {
        match win::start_system(self.tx.clone(), self.clock) {
            Ok(s) => self.sys = Some(s),
            Err(e) => {
                log(&format!("system audio failed: {e:?}"));
                out::warn("no-system-audio");
            }
        }
    }

    fn schedule_mic(&mut self, after: Duration) {
        self.mic_rebuild = Some(Instant::now() + after);
    }

    fn rebuild_system(&mut self) {
        if let Some(s) = self.sys.take() {
            s.stop();
        }
        self.them.resync();
        self.start_system();
        out::warn("device-changed");
    }

    /// A new stream on the chosen mic (or the default). The time in between is silence in me.ogg, so it stays on meeting time.
    fn rebuild_mic(&mut self) {
        if let Some(uid) = &self.mic_uid {
            if win::mic_device(uid).is_none() {
                log("the chosen microphone went away: using the computer's");
                self.mic_uid = None;
                out::warn("mic-gone");
            }
        }
        if let Some(s) = self.mic.take() {
            s.stop();
        }
        self.me.resync();
        if !self.start_mic(true) {
            log("microphone lost");
        }
        out::warn("device-changed");
        self.report_mic();
    }

    /// Which mic records now, for the picker: the chosen one, or Auto with the default's name
    fn report_mic(&self) {
        let dev = match &self.mic_uid {
            Some(u) => win::mic_device(u),
            None => win::default_input(),
        };
        let name = dev.as_ref().and_then(win::friendly_name);
        out::mic(self.mic_uid.as_deref(), name.as_deref());
    }

    /// mic ID, or mic auto: switch now, without stopping the recording. An unknown mic changes nothing.
    fn choose_mic(&mut self, arg: &str) {
        let uid = if arg == "auto" { None } else { Some(arg.to_string()) };
        if let Some(u) = &uid {
            if win::mic_device(u).is_none() {
                log(&format!("no microphone {u} here"));
                self.report_mic();
                return;
            }
        }
        if uid == self.mic_uid && self.mic.is_some() {
            self.report_mic();
            return;
        }
        self.mic_uid = uid;
        if let Some(s) = self.mic.take() {
            s.stop();
        }
        self.me.resync();
        if !self.start_mic(true) {
            log("microphone lost");
        }
        out::warn("device-changed");
        self.report_mic();
    }

    /// true: stop
    fn command(&mut self, c: &str) -> bool {
        match c {
            "pause" => {
                self.paused = true;
                self.me.flush_pending();
                self.them.flush_pending();
            }
            "resume" => {
                self.paused = false;
                self.me.resync();
                self.them.resync();
            }
            "stop" => return true,
            _ if c.starts_with("mic ") => self.choose_mic(c[4..].trim()),
            _ => log(&format!("unknown command: {c}")),
        }
        false
    }

    fn finish(&mut self) {
        if let Some(s) = self.mic.take() {
            s.stop();
        }
        if let Some(s) = self.sys.take() {
            s.stop();
        }
        self.me.flush_pending();
        self.them.flush_pending();
        // both files end together, so they stay the same length
        let end = self.me.pts.max(self.them.pts);
        self.me.pad_to(end);
        self.them.pad_to(end);
        self.me.finish();
        self.them.finish();
    }
}
