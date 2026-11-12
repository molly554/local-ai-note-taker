//! Reads a small PCM or float WAV as mono samples (writer-probe's fixtures)

pub fn read(b: &[u8]) -> Option<(Vec<f32>, u32)> {
    if b.len() < 12 || &b[..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return None;
    }
    let (mut fmt, mut data): (Option<&[u8]>, Option<&[u8]>) = (None, None);
    let mut at = 12;
    while at + 8 <= b.len() {
        let id = &b[at..at + 4];
        let len = u32::from_le_bytes([b[at + 4], b[at + 5], b[at + 6], b[at + 7]]) as usize;
        let body = &b[at + 8..(at + 8 + len).min(b.len())];
        if id == b"fmt " {
            fmt = Some(body);
        } else if id == b"data" {
            data = Some(body);
        }
        at += 8 + len + (len & 1);
    }
    let (f, d) = (fmt?, data?);
    if f.len() < 16 {
        return None;
    }
    let tag = u16::from_le_bytes([f[0], f[1]]);
    let ch = u16::from_le_bytes([f[2], f[3]]).max(1) as usize;
    let rate = u32::from_le_bytes([f[4], f[5], f[6], f[7]]);
    let bits = u16::from_le_bytes([f[14], f[15]]);
    let frames: Vec<f32> = match (tag, bits) {
        (1, 16) => d.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect(),
        (3, 32) => d.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect(),
        _ => return None,
    };
    let mono = frames.chunks_exact(ch).map(|c| c.iter().sum::<f32>() / ch as f32).collect();
    Some((mono, rate))
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_16_bit_pcm() {
        let mut w = b"RIFF\0\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0data\x04\0\0\0".to_vec();
        w.extend_from_slice(&[0x00, 0x40, 0x00, 0xc0]);
        let (s, rate) = super::read(&w).unwrap();
        assert_eq!(rate, 16000);
        assert_eq!(s, vec![0.5, -0.5]);
    }
}
