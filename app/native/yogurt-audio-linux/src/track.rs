//! One track (me or them): its file and its stream, on meeting time. The same rules as the Mac helper's Track:
//! startup, pauses and device rebuilds are written as silence, so both files line up with the pcm ms.

use crate::json::{n, obj, s};
use crate::ogg_opus::OpusWriter;
use crate::resample::Down3;
use std::path::PathBuf;

pub type Out = Box<dyn FnMut(Vec<u8>)>;

pub struct Track {
    pub name: &'static str,
    pub path: PathBuf,
    /// false for a file this run did not start (never delete what is already there)
    fresh: bool,
    writer: Option<OpusWriter>,
    /// samples in the file (48 kHz), the file's time
    pub pts: u64,
    down: Down3,
    /// meeting time when this run of audio began, and 16 kHz samples sent since
    base_ms: Option<f64>,
    sent_since: i64,
    pending: Vec<f32>,
    /// when the last buffer ended, for a device that says when it heard each one
    last_heard_end: Option<f64>,
    sum_sq: f64,
    count: usize,
    start_offset_ms: f64,
    /// false: no pcm frames out (join writes files only)
    pub stream: bool,
    out: Out,
}

pub fn pcm_frame(track: &str, ms: f64, samples: &[f32]) -> Vec<u8> {
    let mut d = obj([("t", s("pcm")), ("track", s(track)), ("ms", n(ms)), ("n", n(samples.len() as f64))]).text().into_bytes();
    d.push(b'\n');
    d.reserve(samples.len() * 4);
    for v in samples { d.extend_from_slice(&v.to_le_bytes()) }
    d
}

impl Track {
    /// a recording's track: DIR/me.ogg, or DIR/me.N.ogg for part N
    pub fn new(name: &'static str, dir: &std::path::Path, part: u32, start_offset_ms: f64, out: Out) -> Self {
        let file = if part == 0 { format!("{name}.ogg") } else { format!("{name}.{part}.ogg") };
        Self::with(name, dir.join(file), part == 0, start_offset_ms, out)
    }
    /// a track that writes to a given file (join)
    pub fn file(name: &'static str, path: PathBuf) -> Self {
        let mut t = Self::with(name, path, true, 0.0, Box::new(|_| {}));
        t.stream = false;
        t
    }
    fn with(name: &'static str, path: PathBuf, fresh: bool, start_offset_ms: f64, out: Out) -> Self {
        Track { name, path, fresh, writer: None, pts: 0, down: Down3::new(), base_ms: None, sent_since: 0, pending: Vec::new(),
            last_heard_end: None, sum_sq: 0.0, count: 0, start_offset_ms, stream: true, out }
    }

    pub fn open_writer(&mut self) -> bool {
        // part 0 starts a meeting's folder fresh; a later part never touches what is there
        if self.fresh { let _ = std::fs::remove_file(&self.path); }
        match OpusWriter::create(&self.path) {
            Ok(w) => { self.writer = Some(w); true }
            Err(e) => { eprintln!("can't write {}: {e}", self.path.display()); false }
        }
    }
    pub fn has_writer(&self) -> bool { self.writer.is_some() }

    /// A new run of audio (start, resume, a rebuilt device): times follow the meeting clock again
    pub fn resync(&mut self) { self.flush_pending(); self.base_ms = None; }

    /// 48 kHz mono audio. heard_ms: when the device heard it, on meeting time, if it says; arrived_ms: when it got here.
    pub fn append(&mut self, buf: &[f32], heard_ms: Option<f64>, arrived_ms: f64) {
        if buf.is_empty() { return }
        let dur = buf.len() as f64 / 48.0;
        // the device stopped delivering for a while: the missing time becomes silence, so later audio stays on
        // meeting time instead of sliding early. Gaps between deliveries only, never a clock that runs a little off.
        if let Some(heard) = heard_ms {
            if let Some(last) = self.last_heard_end { if heard - last > 250.0 { self.resync() } }
            self.last_heard_end = Some(heard + dur);
        }
        if self.base_ms.is_none() {
            let ms = heard_ms.unwrap_or(arrived_ms - dur).max(0.0);
            self.base_ms = Some(ms);
            self.sent_since = 0;
            self.pad_to((ms * 48.0) as u64);
        }
        self.write(buf);
        let mut s16 = Vec::with_capacity(buf.len() / 3 + 1);
        self.down.process(buf, &mut s16);
        for x in &s16 { self.sum_sq += (*x as f64) * (*x as f64) }
        self.count += s16.len();
        self.pending.extend_from_slice(&s16);
        // 100 ms frames
        while self.pending.len() >= 1600 { self.emit(1600) }
    }

    fn emit(&mut self, k: usize) {
        let Some(base) = self.base_ms else { return };
        if k == 0 { return }
        let chunk: Vec<f32> = self.pending.drain(..k).collect();
        let ms = (self.start_offset_ms + base + self.sent_since as f64 / 16.0).round();
        self.sent_since += k as i64;
        if !self.stream { return }
        (self.out)(pcm_frame(self.name, ms, &chunk));
    }
    pub fn flush_pending(&mut self) { let k = self.pending.len(); self.emit(k) }

    /// Silence up to a point on the 48 kHz timeline
    pub fn pad_to(&mut self, target: u64) {
        let zeros = [0f32; 4800];
        while self.pts < target {
            let k = (target - self.pts).min(4800) as usize;
            let before = self.pts;
            self.write(&zeros[..k]);
            if self.pts == before { return }
        }
    }

    pub fn write(&mut self, b: &[f32]) {
        let Some(w) = self.writer.as_mut() else { return };
        match w.write(b) {
            Ok(()) => self.pts += b.len() as u64,
            Err(e) => eprintln!("{}: couldn't write {} samples: {e}", self.name, b.len()),
        }
    }

    /// 0..1 from -60 dB to 0 dB over what came in since the last call
    pub fn level(&mut self) -> f64 {
        let (sq, c) = (self.sum_sq, self.count);
        self.sum_sq = 0.0;
        self.count = 0;
        if c == 0 { return 0.0 }
        let db = 20.0 * ((sq / c as f64).sqrt() + 1e-9).log10();
        (((db + 60.0) / 60.0).clamp(0.0, 1.0) * 1000.0).round() / 1000.0
    }

    pub fn cancel(&mut self) { self.writer = None; let _ = std::fs::remove_file(&self.path); }

    /// true when the file is complete (or there was nothing to write and it is gone)
    pub fn finish(&mut self) -> bool {
        self.flush_pending();
        let Some(w) = self.writer.take() else { return false };
        if self.pts == 0 { drop(w); let _ = std::fs::remove_file(&self.path); return true }
        match w.finish() {
            Ok(()) => true,
            Err(e) => { eprintln!("{}: {e}", self.name); false }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    /// the pcm frames a track sent: (ms, samples)
    fn frames(raw: &[u8]) -> Vec<(f64, usize)> {
        let mut out = Vec::new();
        let mut at = 0;
        while at < raw.len() {
            let nl = at + raw[at..].iter().position(|b| *b == b'\n').unwrap();
            let line = std::str::from_utf8(&raw[at..nl]).unwrap();
            let ms = crate::json::number_field(line, "ms").unwrap();
            let k = crate::json::number_field(line, "n").unwrap() as usize;
            assert!(line.starts_with(r#"{"ms":"#) && line.contains(r#""t":"pcm""#), "{line}");
            out.push((ms, k));
            at = nl + 1 + k * 4;
        }
        out
    }
    fn track(dir: &std::path::Path, part: u32, offset: f64) -> (Track, Rc<RefCell<Vec<u8>>>) {
        let sent = Rc::new(RefCell::new(Vec::new()));
        let s2 = sent.clone();
        let mut t = Track::new("me", dir, part, offset, Box::new(move |d| s2.borrow_mut().extend_from_slice(&d)));
        assert!(t.open_writer());
        (t, sent)
    }
    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("yogurt-track-{}-{}", std::process::id(), crate::random_u32()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn late_start_is_silence_and_pcm_follows_meeting_time() {
        let d = dir();
        let (mut t, sent) = track(&d, 0, 0.0);
        // the first 100 ms of sound arrives 600 ms in: it began at 500 ms
        t.append(&vec![0.1; 4800], None, 600.0);
        assert_eq!(t.pts, 500 * 48 + 4800);
        t.append(&vec![0.1; 4800], None, 700.0);
        let f = frames(&sent.borrow());
        assert_eq!(f, vec![(500.0, 1600), (600.0, 1600)]);
        assert!(t.finish());
        assert_eq!(crate::ogg_opus::info(&d.join("me.ogg")).unwrap().samples, 700 * 48);
    }

    #[test]
    fn a_gap_in_deliveries_becomes_silence() {
        let d = dir();
        let (mut t, sent) = track(&d, 0, 0.0);
        t.append(&vec![0.1; 4800], Some(0.0), 100.0);
        t.append(&vec![0.1; 4800], Some(100.0), 200.0);
        // nothing for 400 ms
        t.append(&vec![0.1; 4800], Some(600.0), 700.0);
        assert_eq!(t.pts, 700 * 48);
        let f = frames(&sent.borrow());
        assert_eq!(f.iter().map(|x| x.0).collect::<Vec<_>>(), vec![0.0, 100.0, 600.0]);
        // a small wobble changes nothing
        t.append(&vec![0.1; 4800], Some(810.0), 910.0);
        assert_eq!(t.pts, 800 * 48);
    }

    #[test]
    fn a_later_part_carries_on_from_its_start_and_keeps_the_first() {
        let d = dir();
        std::fs::write(d.join("me.ogg"), b"the first part").unwrap();
        let (mut t, sent) = track(&d, 2, 61_000.0);
        assert_eq!(t.path, d.join("me.2.ogg"));
        t.append(&vec![0.1; 4800], None, 100.0);
        assert_eq!(frames(&sent.borrow()), vec![(61_000.0, 1600)]);
        assert!(t.finish());
        assert_eq!(std::fs::read(d.join("me.ogg")).unwrap(), b"the first part");
    }

    #[test]
    fn resync_flushes_and_waits_for_the_clock() {
        let d = dir();
        let (mut t, sent) = track(&d, 0, 0.0);
        t.append(&vec![0.1; 2400], None, 50.0);
        t.resync();
        t.append(&vec![0.1; 4800], None, 1100.0);
        let f = frames(&sent.borrow());
        assert_eq!(f, vec![(0.0, 800), (1000.0, 1600)]);
        assert_eq!(t.pts, 1100 * 48);
    }

    #[test]
    fn levels_and_an_empty_track() {
        let d = dir();
        let (mut t, _) = track(&d, 0, 0.0);
        assert_eq!(t.level(), 0.0);
        t.append(&vec![1.0; 4800], None, 100.0);
        assert!(t.level() > 0.95);
        let (mut e, _) = track(&d, 1, 0.0);
        assert!(e.finish());
        assert!(!d.join("me.1.ogg").exists());
    }
}
