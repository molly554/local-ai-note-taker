//! 48 kHz to 16 kHz for transcription (and back up, for test fixtures): a windowed-sinc low-pass, a third of the samples kept.

const TAPS: usize = 95;

fn low_pass(cutoff: f64, rate: f64) -> Vec<f32> {
    let fc = cutoff / rate;
    let m = (TAPS - 1) as f64 / 2.0;
    let mut h: Vec<f64> = (0..TAPS)
        .map(|i| {
            let x = i as f64 - m;
            let sinc = if x == 0.0 { 2.0 * fc } else { (2.0 * std::f64::consts::PI * fc * x).sin() / (std::f64::consts::PI * x) };
            // Blackman window
            let w = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (TAPS - 1) as f64).cos()
                + 0.08 * (4.0 * std::f64::consts::PI * i as f64 / (TAPS - 1) as f64).cos();
            sinc * w
        })
        .collect();
    let sum: f64 = h.iter().sum();
    for x in &mut h {
        *x /= sum;
    }
    h.into_iter().map(|x| x as f32).collect()
}

/// A ring of the last TAPS samples and the filter over it
struct Fir {
    taps: Vec<f32>,
    ring: Vec<f32>,
    pos: usize,
}

impl Fir {
    fn new() -> Fir {
        Fir { taps: low_pass(7_200.0, 48_000.0), ring: vec![0.0; TAPS], pos: 0 }
    }
    fn push(&mut self, x: f32) {
        self.ring[self.pos] = x;
        self.pos = (self.pos + 1) % TAPS;
    }
    fn out(&self) -> f32 {
        let mut acc = 0.0f32;
        for k in 0..TAPS {
            acc += self.taps[k] * self.ring[(self.pos + TAPS - 1 - k) % TAPS];
        }
        acc
    }
}

/// 48 kHz in, 16 kHz out, carried across calls
pub struct Down3 {
    fir: Fir,
    phase: usize,
}

impl Default for Down3 {
    fn default() -> Self {
        Down3 { fir: Fir::new(), phase: 0 }
    }
}

impl Down3 {
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for &x in input {
            self.fir.push(x);
            self.phase += 1;
            if self.phase == 3 {
                self.phase = 0;
                out.push(self.fir.out());
            }
        }
    }
}

/// 16 kHz in, 48 kHz out (fixtures for writer-probe)
pub fn up3(input: &[f32]) -> Vec<f32> {
    let mut fir = Fir::new();
    let mut out = Vec::with_capacity(input.len() * 3);
    for &x in input {
        for k in 0..3 {
            fir.push(if k == 0 { x * 3.0 } else { 0.0 });
            out.push(fir.out());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(f: f64, n: usize) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * f * i as f64 / 48_000.0).sin() as f32 * 0.5).collect()
    }
    fn rms(v: &[f32]) -> f64 {
        (v.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / v.len() as f64).sqrt()
    }

    #[test]
    fn a_third_of_the_samples_come_out() {
        let mut d = Down3::default();
        let mut out = Vec::new();
        d.process(&[0.0; 4800], &mut out);
        assert_eq!(out.len(), 1600);
        // any chunking gives the same samples
        let input = tone(1000.0, 4801);
        let mut whole = Vec::new();
        Down3::default().process(&input, &mut whole);
        let mut parts = Vec::new();
        let mut d = Down3::default();
        for c in input.chunks(7) {
            d.process(c, &mut parts);
        }
        assert_eq!(whole, parts);
        assert_eq!(whole.len(), 1600);
    }

    #[test]
    fn speech_passes_and_what_would_alias_does_not() {
        let mut keep = Vec::new();
        Down3::default().process(&tone(1000.0, 48_000), &mut keep);
        assert!((rms(&keep[200..]) - 0.5 / 2f64.sqrt()).abs() < 0.01);
        let mut cut = Vec::new();
        Down3::default().process(&tone(12_000.0, 48_000), &mut cut);
        assert!(rms(&cut[200..]) < 0.5 / 2f64.sqrt() * 0.001, "{}", rms(&cut[200..]));
        let mut dc = Vec::new();
        Down3::default().process(&[1.0; 4800], &mut dc);
        assert!((dc[1000] - 1.0).abs() < 1e-4);
    }

    #[test]
    fn up_and_down_keeps_the_signal() {
        let src: Vec<f32> = (0..16_000).map(|i| (2.0 * std::f64::consts::PI * 500.0 * i as f64 / 16_000.0).sin() as f32 * 0.5).collect();
        let up = up3(&src);
        assert_eq!(up.len(), 48_000);
        assert!((rms(&up[600..]) - rms(&src[200..])).abs() < 0.01);
    }
}
