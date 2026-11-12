//! One track: its file (48 kHz Ogg Opus on meeting time) and its 16 kHz stream (100 ms pcm frames)
use std::path::{Path, PathBuf};

use crate::oggopus::OpusWriter;
use crate::out;
use crate::resample::Down3;

pub struct Track {
    pub name: &'static str,
    pub path: PathBuf,
    /// false for a file this run did not start (never delete what is already there)
    fresh: bool,
    writer: Option<OpusWriter>,
    /// samples written to the file, at 48 kHz
    pub pts: i64,
    /// the stream's timeline: meeting time when this run of audio began, and samples sent since
    base_ms: Option<f64>,
    sent_since: i64,
    pending: Vec<f32>,
    /// meeting time the device's last buffer ended at, when it says (the computer's sound does)
    last_heard_end: Option<f64>,
    sum_sq: f64,
    count: usize,
    /// false: no pcm frames out
    pub stream: bool,
    /// where this part starts on meeting time (a restart after a crash carries on from there)
    start_offset_ms: f64,
    down: Down3,
}

impl Track {
    /// Part 0 writes DIR/me.ogg, a restart (part N) DIR/me.N.ogg
    pub fn new(name: &'static str, dir: &Path, part: u32, start_offset_ms: f64) -> Track {
        let file = if part == 0 { format!("{name}.ogg") } else { format!("{name}.{part}.ogg") };
        let mut t = Track::with_file(name, dir.join(file));
        t.fresh = part == 0;
        t.start_offset_ms = start_offset_ms;
        t
    }

    /// A track that writes to a given file (join)
    pub fn with_file(name: &'static str, path: PathBuf) -> Track {
        Track {
            name,
            path,
            fresh: true,
            writer: None,
            pts: 0,
            base_ms: None,
            sent_since: 0,
            pending: Vec::new(),
            last_heard_end: None,
            sum_sq: 0.0,
            count: 0,
            stream: true,
            start_offset_ms: 0.0,
            down: Down3::default(),
        }
    }

    pub fn open_writer(&mut self) {
        // part 0 starts a meeting's folder fresh; a later part never touches what is there
        match OpusWriter::create(&self.path, self.fresh) {
            Ok(w) => self.writer = Some(w),
            Err(e) => out::log(&format!("can't write {}: {e}", self.path.display())),
        }
    }

    pub fn has_writer(&self) -> bool {
        self.writer.is_some()
    }

    /// A new run of audio (start, resume, a rebuilt device): times follow the meeting clock again
    pub fn resync(&mut self) {
        self.flush_pending();
        self.base_ms = None;
    }

    /// 48 kHz mono audio. heard_ms: when the device heard it, on meeting time, if it says; now_ms: meeting time now
    pub fn append(&mut self, buf: &[f32], heard_ms: Option<f64>, now_ms: f64) {
        if buf.is_empty() {
            return;
        }
        let dur = buf.len() as f64 / 48.0;
        // the device stopped delivering for a while: the missing time becomes silence, so later audio stays on meeting time
        if let Some(heard) = heard_ms {
            if let Some(last) = self.last_heard_end {
                if heard - last > 250.0 {
                    self.resync();
                }
            }
            self.last_heard_end = Some(heard + dur);
        }
        if self.base_ms.is_none() {
            let ms = heard_ms.unwrap_or(now_ms - dur).max(0.0);
            self.base_ms = Some(ms);
            self.sent_since = 0;
            // file time is meeting time: startup, pauses and device rebuilds become silence
            self.pad_to((ms * 48.0) as i64);
        }
        self.write(buf);
        let before = self.pending.len();
        self.down.process(buf, &mut self.pending);
        for &x in &self.pending[before..] {
            self.sum_sq += (x * x) as f64;
        }
        self.count += self.pending.len() - before;
        // 100 ms frames
        while self.pending.len() >= 1600 {
            self.emit(1600);
        }
    }

    fn emit(&mut self, n: usize) {
        let Some(base) = self.base_ms else { return };
        if n == 0 {
            return;
        }
        let chunk: Vec<f32> = self.pending.drain(..n).collect();
        let ms = (self.start_offset_ms + base + self.sent_since as f64 / 16.0).round() as i64;
        self.sent_since += n as i64;
        if self.stream {
            out::pcm(self.name, ms, &chunk);
        }
    }

    pub fn flush_pending(&mut self) {
        let n = self.pending.len();
        self.emit(n);
        // without a timeline (nothing heard yet) there is nothing to send
        self.pending.clear();
    }

    /// Silence up to a point on the 48 kHz timeline
    pub fn pad_to(&mut self, target: i64) {
        let zeros = [0f32; 4800];
        while self.pts < target {
            let n = (target - self.pts).min(4800) as usize;
            let before = self.pts;
            self.write(&zeros[..n]);
            if self.pts == before {
                return;
            }
        }
    }

    pub fn write(&mut self, b: &[f32]) {
        let Some(w) = self.writer.as_mut() else { return };
        match w.write(b) {
            Ok(()) => self.pts += b.len() as i64,
            Err(e) => {
                out::log(&format!("{}: can't write audio: {e}", self.name));
                self.writer = None;
            }
        }
    }

    /// 0..1 from -60 dB to 0 dB over what came in since the last call
    pub fn level(&mut self) -> f64 {
        let (s, c) = (self.sum_sq, self.count);
        self.sum_sq = 0.0;
        self.count = 0;
        if c == 0 {
            return 0.0;
        }
        let db = 20.0 * ((s / c as f64).sqrt() + 1e-9).log10();
        (((db + 60.0) / 60.0).clamp(0.0, 1.0) * 1000.0).round() / 1000.0
    }

    pub fn cancel(&mut self) {
        self.writer = None;
        let _ = std::fs::remove_file(&self.path);
    }

    /// Ends the file; one that never got audio is removed. Ok(false): it could not be finished.
    pub fn finish(&mut self) -> bool {
        self.flush_pending();
        let Some(w) = self.writer.take() else { return false };
        if self.pts == 0 {
            drop(w);
            let _ = std::fs::remove_file(&self.path);
            return true;
        }
        match w.finish() {
            Ok(()) => true,
            Err(e) => {
                out::log(&format!("{}: {e}", self.name));
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(dir: &Path) -> Track {
        let mut t = Track::new("me", dir, 0, 0.0);
        t.stream = false;
        t.open_writer();
        t
    }

    #[test]
    fn audio_starts_where_it_was_heard_on_meeting_time() {
        let dir = crate::testdir("track-start");
        let mut t = track(&dir);
        t.append(&[0.1; 4800], Some(500.0), 600.0);
        assert_eq!(t.pts, 500 * 48 + 4800);
        assert_eq!(t.base_ms, Some(500.0));
        assert_eq!(t.sent_since, 1600);
        assert!(t.finish());
        let i = crate::oggopus::info(&dir.join("me.ogg")).unwrap();
        assert_eq!(i.duration_ms, 600.0);
    }

    #[test]
    fn a_gap_of_more_than_250_ms_is_silence_in_the_file() {
        let dir = crate::testdir("track-gap");
        let mut t = track(&dir);
        t.append(&[0.1; 4800], Some(0.0), 100.0);
        // 200 ms late: within the rule, the audio follows on
        t.append(&[0.1; 4800], Some(300.0), 400.0);
        assert_eq!(t.pts, 9600);
        // 1 s late: the time between is silence
        t.append(&[0.1; 4800], Some(1500.0), 1600.0);
        assert_eq!(t.pts, 1500 * 48 + 4800);
    }

    #[test]
    fn without_device_times_the_buffer_ends_now() {
        let dir = crate::testdir("track-now");
        let mut t = track(&dir);
        t.append(&[0.0; 4800], None, 1000.0);
        assert_eq!(t.base_ms, Some(900.0));
        t.pause_like_resume();
        t.append(&[0.0; 4800], None, 3000.0);
        assert_eq!(t.pts, 2900 * 48 + 4800);
    }

    #[test]
    fn levels_run_from_minus_60_db_to_0_db() {
        let dir = crate::testdir("track-level");
        let mut t = track(&dir);
        assert_eq!(t.level(), 0.0);
        t.append(&[0.0; 4800], Some(0.0), 100.0);
        assert_eq!(t.level(), 0.0);
        // half of full scale is -6 dB
        t.append(&vec![0.5; 9600], Some(100.0), 300.0);
        let l = t.level();
        assert!(l > 0.85 && l <= 0.9, "{l}");
        assert_eq!(t.level(), 0.0);
    }

    #[test]
    fn a_track_that_heard_nothing_leaves_no_file() {
        let dir = crate::testdir("track-empty");
        let mut t = track(&dir);
        assert!(dir.join("me.ogg").exists());
        assert!(t.finish());
        assert!(!dir.join("me.ogg").exists());
    }

    #[test]
    fn parts_are_named_like_the_mac_helper_names_them() {
        let dir = Path::new("x");
        assert_eq!(Track::new("them", dir, 0, 0.0).path, dir.join("them.ogg"));
        assert_eq!(Track::new("them", dir, 2, 5000.0).path, dir.join("them.2.ogg"));
    }

    impl Track {
        fn pause_like_resume(&mut self) {
            self.resync()
        }
    }
}
