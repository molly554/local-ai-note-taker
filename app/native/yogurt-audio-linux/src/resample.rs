//! 48 kHz down to 16 kHz for the pcm stream (what whisper hears): a low-pass filter, then every third sample.
//! PulseAudio already gives one channel at 48 kHz, so this is the only rate change the recorder makes.

const TAPS: usize = 63;

pub struct Down3 {
    taps: Vec<f32>,
    /// the last TAPS-1 input samples
    hist: Vec<f32>,
    /// index, in hist + the next input, of the newest sample the next output uses
    next: usize,
}

impl Default for Down3 {
    fn default() -> Self { Self::new() }
}

impl Down3 {
    pub fn new() -> Self {
        // windowed sinc (Blackman), cut at 7 kHz: below the 8 kHz Nyquist of 16 kHz, above speech
        let fc = 7000.0 / 48000.0;
        let m = (TAPS - 1) as f64;
        let mut taps: Vec<f64> = (0..TAPS).map(|i| {
            let x = i as f64 - m / 2.0;
            let sinc = if x == 0.0 { 2.0 * fc } else { (2.0 * std::f64::consts::PI * fc * x).sin() / (std::f64::consts::PI * x) };
            let w = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / m).cos() + 0.08 * (4.0 * std::f64::consts::PI * i as f64 / m).cos();
            sinc * w
        }).collect();
        let sum: f64 = taps.iter().sum();
        for t in taps.iter_mut() { *t /= sum }
        Down3 { taps: taps.into_iter().map(|t| t as f32).collect(), hist: vec![0.0; TAPS - 1], next: TAPS - 1 }
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        let mut buf = std::mem::take(&mut self.hist);
        buf.extend_from_slice(input);
        let mut i = self.next;
        while i < buf.len() {
            let w = &buf[i + 1 - TAPS..=i];
            out.push(w.iter().zip(&self.taps).map(|(a, b)| a * b).sum());
            i += 3;
        }
        let keep = buf.len() - (TAPS - 1);
        self.next = i - keep;
        self.hist = buf[keep..].to_vec();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(hz: f64, n: usize) -> Vec<f32> {
        (0..n).map(|i| (0.5 * (2.0 * std::f64::consts::PI * hz * i as f64 / 48000.0).sin()) as f32).collect()
    }
    fn rms(x: &[f32]) -> f64 { (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt() }

    #[test]
    fn a_third_of_the_samples_in_any_chunking() {
        let input = tone(440.0, 48000);
        let mut whole = Vec::new();
        Down3::new().process(&input, &mut whole);
        assert_eq!(whole.len(), 16000);
        // the same samples whatever size the buffers come in
        let mut d = Down3::new();
        let mut parts = Vec::new();
        for c in input.chunks(1021) { d.process(c, &mut parts) }
        assert_eq!(parts.len(), 16000);
        for (a, b) in whole.iter().zip(&parts) { assert!((a - b).abs() < 1e-6) }
    }

    #[test]
    fn keeps_speech_and_drops_what_would_alias() {
        let mut low = Vec::new();
        Down3::new().process(&tone(1000.0, 48000), &mut low);
        let r = rms(&low[100..]);
        assert!((r - 0.5 / 2f64.sqrt()).abs() < 0.01, "1 kHz rms {r}");
        let mut high = Vec::new();
        Down3::new().process(&tone(12000.0, 48000), &mut high);
        assert!(rms(&high[100..]) < 0.005, "12 kHz leaked: {}", rms(&high[100..]));
    }
}
