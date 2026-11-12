//! Windows loopback sends nothing while nothing plays. The computer's track gets silence on the helper's own clock
//! instead, so `them` keeps flowing on meeting time as the Mac's tap does.

/// Silence starts after this long without audio (ms)
const AFTER: f64 = 100.0;
/// and stops this far behind now, so audio arriving late is not doubled
const MARGIN: f64 = 30.0;

pub struct GapFiller {
    /// meeting time the track has reached (ms)
    end: f64,
    /// the last stretch was made-up silence
    filled: bool,
}

impl GapFiller {
    pub fn new(start_ms: f64) -> GapFiller {
        GapFiller { end: start_ms, filled: false }
    }

    /// Audio heard at heard_ms, frames long at 48 kHz: how many of its first frames repeat time already given as silence
    pub fn packet(&mut self, heard_ms: f64, frames: usize) -> usize {
        let skip = if self.filled { (((self.end - heard_ms) * 48.0).round().max(0.0) as usize).min(frames) } else { 0 };
        self.filled = false;
        self.end = self.end.max(heard_ms + frames as f64 / 48.0);
        skip
    }

    /// Nothing came in: the silence due by now, as (meeting time it starts at, frames)
    pub fn idle(&mut self, now_ms: f64) -> Option<(f64, usize)> {
        let upto = now_ms - MARGIN;
        if upto - self.end < AFTER {
            return None;
        }
        let frames = ((upto - self.end) * 48.0) as usize;
        let at = self.end;
        self.end += frames as f64 / 48.0;
        self.filled = true;
        Some((at, frames))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steady_audio_is_left_alone() {
        let mut g = GapFiller::new(0.0);
        for i in 0..100 {
            // a little jitter in the device's times never trims real audio
            let jitter = if i % 2 == 0 { 0.4 } else { -0.4 };
            assert_eq!(g.packet(i as f64 * 10.0 + jitter, 480), 0);
            assert_eq!(g.idle(i as f64 * 10.0 + 20.0), None);
        }
    }

    #[test]
    fn quiet_time_becomes_silence_up_to_just_before_now() {
        let mut g = GapFiller::new(0.0);
        assert_eq!(g.idle(50.0), None);
        let (at, frames) = g.idle(200.0).unwrap();
        assert_eq!(at, 0.0);
        assert_eq!(frames, 170 * 48);
        // too soon for more
        assert_eq!(g.idle(250.0), None);
        let (at, frames) = g.idle(400.0).unwrap();
        assert_eq!(at, 170.0);
        assert_eq!(frames, 200 * 48);
    }

    #[test]
    fn audio_after_silence_skips_what_the_silence_covered() {
        let mut g = GapFiller::new(0.0);
        g.idle(1000.0).unwrap(); // silence to 970 ms
        // sound started at 960 ms: its first 10 ms are already silence
        assert_eq!(g.packet(960.0, 480), 480);
        assert_eq!(g.packet(970.0, 480), 0);
        // and after silence that ended before the sound, nothing is skipped
        let mut g = GapFiller::new(0.0);
        g.idle(1000.0).unwrap();
        assert_eq!(g.packet(985.0, 480), 0);
    }
}
