//! Ogg Opus files (RFC 7845), 48 kHz mono. A page goes to disk every second, so a crash loses at most that.
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

use crate::ogg::{self, PageWriter};
use crate::opus::{Decoder, Encoder, FRAME};

/// Packets per page: 50 x 20 ms
const PAGE_PACKETS: usize = 50;

pub struct OpusWriter {
    file: File,
    pages: PageWriter,
    enc: Encoder,
    preskip: u16,
    buf: Vec<f32>,
    /// samples sent through the encoder in whole frames
    encoded: u64,
    /// samples given to the file (the end is trimmed to this)
    real: u64,
}

fn serial() -> u32 {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    (t ^ (t >> 32) ^ (std::process::id() as u64).wrapping_mul(0x9e37_79b9)) as u32
}

pub fn head(preskip: u16) -> Vec<u8> {
    let mut h = b"OpusHead".to_vec();
    h.push(1); // version
    h.push(1); // channels
    h.extend_from_slice(&preskip.to_le_bytes());
    h.extend_from_slice(&48_000u32.to_le_bytes());
    h.extend_from_slice(&0i16.to_le_bytes()); // output gain
    h.push(0); // mapping family: mono/stereo
    h
}

pub fn tags() -> Vec<u8> {
    let vendor = b"yogurt-audio";
    let mut t = b"OpusTags".to_vec();
    t.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    t.extend_from_slice(vendor);
    t.extend_from_slice(&0u32.to_le_bytes());
    t
}

impl OpusWriter {
    /// new: false refuses to replace a file that is there (a later part never touches what exists)
    pub fn create(path: &Path, replace: bool) -> io::Result<OpusWriter> {
        let enc = Encoder::new().ok_or_else(|| io::Error::new(io::ErrorKind::Other, "opus encoder"))?;
        let mut o = OpenOptions::new();
        o.write(true);
        if replace {
            o.create(true).truncate(true);
        } else {
            o.create_new(true);
        }
        let mut file = o.open(path)?;
        let preskip = enc.lookahead();
        let mut pages = PageWriter::new(serial());
        pages.add(&head(preskip));
        let mut bytes = pages.page(0, ogg::BOS);
        pages.add(&tags());
        bytes.extend(pages.page(0, 0));
        file.write_all(&bytes)?;
        file.flush()?;
        Ok(OpusWriter { file, pages, enc, preskip, buf: Vec::with_capacity(FRAME * 2), encoded: 0, real: 0 })
    }

    pub fn write(&mut self, samples: &[f32]) -> io::Result<()> {
        self.real += samples.len() as u64;
        self.buf.extend_from_slice(samples);
        let mut at = 0;
        while self.buf.len() - at >= FRAME {
            let frame: Vec<f32> = self.buf[at..at + FRAME].to_vec();
            at += FRAME;
            self.packet(&frame)?;
        }
        self.buf.drain(..at);
        Ok(())
    }

    fn packet(&mut self, frame: &[f32]) -> io::Result<()> {
        let p = self.enc.encode(frame).ok_or_else(|| io::Error::new(io::ErrorKind::Other, "opus encode"))?;
        if !self.pages.fits(p.len()) {
            self.flush_page(0)?;
        }
        self.pages.add(&p);
        self.encoded += FRAME as u64;
        if self.pages.packets() >= PAGE_PACKETS {
            self.flush_page(0)?;
        }
        Ok(())
    }

    fn flush_page(&mut self, flags: u8) -> io::Result<()> {
        // granule: samples decoded through this page, the pre-skip included; the last page trims the end back to what was written
        let granule = (if flags & ogg::EOS != 0 { self.preskip as u64 + self.real } else { self.encoded }) as i64;
        let page = self.pages.page(granule, flags);
        self.file.write_all(&page)?;
        self.file.flush()
    }

    /// The last frame padded out, and the end trimmed back to what was written
    pub fn finish(mut self) -> io::Result<()> {
        // the encoder holds pre-skip samples back: push silence through until every written sample is out
        let need = self.buf.len() + self.preskip as usize;
        let mut rest = std::mem::take(&mut self.buf);
        rest.resize(need.div_ceil(FRAME) * FRAME, 0.0);
        for f in rest.chunks(FRAME) {
            self.packet(f)?;
        }
        self.flush_page(ogg::EOS)?;
        self.file.sync_all()
    }
}

/// What a file says about itself without decoding: its length and size
pub struct Info {
    pub duration_ms: f64,
    pub bytes: u64,
}

fn preskip_of(head: &[u8]) -> Option<u16> {
    if head.len() < 19 || &head[..8] != b"OpusHead" {
        return None;
    }
    Some(u16::from_le_bytes([head[10], head[11]]))
}

/// Length from the last intact page's granule position; None when it is not an Ogg Opus file
pub fn info(path: &Path) -> Option<Info> {
    let b = std::fs::read(path).ok()?;
    let ps = ogg::pages(&b);
    let first = ps.first()?;
    let preskip = preskip_of(ogg::packets(std::slice::from_ref(first)).first()?)? as i64;
    let last = ps.iter().rev().find(|p| p.granule > 0).map(|p| p.granule).unwrap_or(preskip);
    Some(Info { duration_ms: ((last - preskip).max(0) as f64) / 48.0, bytes: b.len() as u64 })
}

/// Decodes a file a packet at a time into each(samples); the number of samples, None when it can't be read
pub fn decode(path: &Path, mut each: impl FnMut(&[f32]) -> bool) -> Option<u64> {
    let b = std::fs::read(path).ok()?;
    let ps = ogg::pages(&b);
    let packets = ogg::packets(&ps);
    let preskip = preskip_of(packets.first()?)? as u64;
    if packets.len() < 2 || &packets[1].get(..8)? != b"OpusTags" {
        return None;
    }
    let last = ps.iter().rev().find(|p| p.granule > 0).map(|p| p.granule as u64).unwrap_or(preskip);
    let total = last.saturating_sub(preskip);
    let mut dec = Decoder::new()?;
    let mut skip = preskip;
    let mut given = 0u64;
    for p in &packets[2..] {
        let s = dec.decode(p)?;
        let mut s = &s[..];
        if skip > 0 {
            let k = (skip as usize).min(s.len());
            s = &s[k..];
            skip -= k as u64;
        }
        let left = total - given;
        if (s.len() as u64) > left {
            s = &s[..left as usize];
        }
        if !s.is_empty() {
            if !each(s) {
                return None;
            }
            given += s.len() as u64;
        }
        if given >= total {
            break;
        }
    }
    Some(given)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(n: usize) -> Vec<f32> {
        (0..n).map(|i| (i as f32 * 2.0 * std::f32::consts::PI * 440.0 / 48_000.0).sin() * 0.3).collect()
    }

    #[test]
    fn a_file_decodes_to_exactly_what_was_written() {
        let dir = crate::testdir("oggopus-exact");
        let path = dir.join("me.ogg");
        let mut w = OpusWriter::create(&path, true).unwrap();
        // odd sizes, as devices deliver them
        let all = tone(48_000 * 3 + 123);
        for c in all.chunks(441) {
            w.write(c).unwrap();
        }
        w.finish().unwrap();
        let i = info(&path).unwrap();
        assert!((i.duration_ms - (48_000.0 * 3.0 + 123.0) / 48.0).abs() < 0.01, "{}", i.duration_ms);
        let mut out = Vec::new();
        let n = decode(&path, |s| { out.extend_from_slice(s); true }).unwrap();
        assert_eq!(n as usize, all.len());
        // lossy, but the tone is there at about its level
        let rms = |v: &[f32]| (v.iter().map(|x| (x * x) as f64).sum::<f64>() / v.len() as f64).sqrt();
        let (a, b) = (rms(&all[4800..all.len() - 4800]), rms(&out[4800..out.len() - 4800]));
        assert!((a - b).abs() < 0.05, "{a} {b}");
    }

    #[test]
    fn a_crash_keeps_every_whole_second() {
        let dir = crate::testdir("oggopus-crash");
        let path = dir.join("them.ogg");
        let mut w = OpusWriter::create(&path, true).unwrap();
        w.write(&tone(48_000 * 2 + 500)).unwrap();
        // never finished: the process went away
        std::mem::forget(w);
        let preskip = Encoder::new().unwrap().lookahead() as u64;
        let i = info(&path).unwrap();
        assert_eq!(i.duration_ms, (96_000 - preskip) as f64 / 48.0);
        assert_eq!(decode(&path, |_| true), Some(96_000 - preskip));
    }

    #[test]
    fn a_later_part_never_replaces_a_file() {
        let dir = crate::testdir("oggopus-new");
        let path = dir.join("me.1.ogg");
        std::fs::write(&path, b"keep").unwrap();
        assert!(OpusWriter::create(&path, false).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"keep");
    }

    #[test]
    fn the_header_is_ogg_opus() {
        let h = head(312);
        assert_eq!(h.len(), 19);
        assert_eq!(preskip_of(&h), Some(312));
        assert_eq!(&tags()[..8], b"OpusTags");
    }
}
