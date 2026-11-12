//! Ogg Opus files (RFC 7845), mono 48 kHz: what the recorder writes and what join and inspect read.
//! A page goes to disk every second, so a crash loses at most about a second (the Mac's m4a keeps 5 s fragments).

use ogg::reading::PacketReader;
use ogg::writing::{PacketWriteEndInfo, PacketWriter};
use opus::{Application, Bitrate, Channels, Decoder, Encoder};
use std::fs::File;
use std::io::{self, BufReader};
use std::path::Path;

pub const RATE: u64 = 48000;
const FRAME: usize = 960; // 20 ms
const PACKETS_PER_PAGE: u32 = 50; // 1 s
/// about the size of the Mac's HE-AAC 16 kb/s, and clear for voices
pub const BITRATE: i32 = 20000;

fn bad(e: impl std::fmt::Display) -> io::Error { io::Error::new(io::ErrorKind::Other, e.to_string()) }

pub struct OpusWriter {
    pw: PacketWriter<'static, File>,
    enc: Encoder,
    serial: u32,
    pre_skip: u64,
    frame: Vec<f32>,
    /// samples given to the encoder, padding included: the granule position after the last packet
    encoded: u64,
    /// samples of real audio written (silence the recorder pads with counts: it is meeting time)
    total: u64,
    in_page: u32,
    out: Vec<u8>,
}

impl OpusWriter {
    pub fn create(path: &Path) -> io::Result<Self> {
        let mut enc = Encoder::new(RATE as u32, Channels::Mono, Application::Audio).map_err(bad)?;
        enc.set_bitrate(Bitrate::Bits(BITRATE)).map_err(bad)?;
        let pre_skip = enc.get_lookahead().map_err(bad)?.max(0) as u64;
        let file = File::create(path)?;
        let serial = std::process::id() ^ (crate::random_u32());
        let mut w = OpusWriter { pw: PacketWriter::new(file), enc, serial, pre_skip, frame: Vec::with_capacity(FRAME), encoded: 0, total: 0, in_page: 0, out: vec![0; 4000] };
        let mut head = b"OpusHead".to_vec();
        head.push(1); // version
        head.push(1); // channels
        head.extend_from_slice(&(pre_skip as u16).to_le_bytes());
        head.extend_from_slice(&(RATE as u32).to_le_bytes());
        head.extend_from_slice(&0i16.to_le_bytes()); // gain
        head.push(0); // mapping family
        w.pw.write_packet(head, serial, PacketWriteEndInfo::EndPage, 0)?;
        let vendor = b"Yogurt";
        let mut tags = b"OpusTags".to_vec();
        tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
        tags.extend_from_slice(vendor);
        tags.extend_from_slice(&0u32.to_le_bytes());
        w.pw.write_packet(tags, serial, PacketWriteEndInfo::EndPage, 0)?;
        Ok(w)
    }

    /// samples of audio in the file so far (48 kHz)
    pub fn samples(&self) -> u64 { self.total }

    pub fn write(&mut self, samples: &[f32]) -> io::Result<()> {
        let mut rest = samples;
        while !rest.is_empty() {
            let take = (FRAME - self.frame.len()).min(rest.len());
            self.frame.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            self.total += take as u64;
            if self.frame.len() == FRAME { self.packet(false)? }
        }
        Ok(())
    }

    fn packet(&mut self, last: bool) -> io::Result<()> {
        self.frame.resize(FRAME, 0.0);
        let n = self.enc.encode_float(&self.frame, &mut self.out).map_err(bad)?;
        self.frame.clear();
        self.encoded += FRAME as u64;
        self.in_page += 1;
        // the last page's granule says where the audio really ends, so the padding at the end is cut off on playback
        let (end, gp) = if last { (PacketWriteEndInfo::EndStream, self.pre_skip + self.total) }
            else if self.in_page >= PACKETS_PER_PAGE { (PacketWriteEndInfo::EndPage, self.encoded) }
            else { (PacketWriteEndInfo::NormalPacket, self.encoded) };
        if end != PacketWriteEndInfo::NormalPacket { self.in_page = 0 }
        self.pw.write_packet(self.out[..n].to_vec(), self.serial, end, gp)
    }

    /// The rest of the audio, the encoder's look-ahead flushed with silence, and the end of the stream
    pub fn finish(mut self) -> io::Result<()> {
        let needed = self.pre_skip + self.total;
        loop {
            let after = self.encoded + FRAME as u64;
            let last = after >= needed;
            self.packet(last)?;
            if last { break }
        }
        self.pw.inner_mut().sync_data()
    }
}

/// What a file holds: audio samples (48 kHz) by its pages' granule positions, without decoding
pub struct Info { pub samples: u64, pub bytes: u64, pub channels: u8 }

fn head(data: &[u8]) -> io::Result<(u8, u64)> {
    if data.len() < 19 || &data[..8] != b"OpusHead" { return Err(bad("not an Ogg Opus file")) }
    Ok((data[9], u16::from_le_bytes([data[10], data[11]]) as u64))
}

pub fn info(path: &Path) -> io::Result<Info> {
    let bytes = std::fs::metadata(path)?.len();
    let mut r = PacketReader::new(BufReader::new(File::open(path)?));
    let first = r.read_packet().map_err(bad)?.ok_or_else(|| bad("empty file"))?;
    let (channels, pre_skip) = head(&first.data)?;
    let mut last_gp = 0u64;
    // a file a crash cut short ends at its last whole page
    while let Ok(Some(p)) = r.read_packet() {
        if p.last_in_page() && p.absgp_page() != u64::MAX { last_gp = last_gp.max(p.absgp_page()) }
    }
    Ok(Info { samples: last_gp.saturating_sub(pre_skip), bytes, channels })
}

/// Decodes a file into 48 kHz mono, giving the audio to sink in pieces; returns how many samples there were.
/// A file a crash cut short gives what it has.
pub fn decode(path: &Path, mut sink: impl FnMut(&[f32]) -> io::Result<()>) -> io::Result<u64> {
    let mut r = PacketReader::new(BufReader::new(File::open(path)?));
    let first = r.read_packet().map_err(bad)?.ok_or_else(|| bad("empty file"))?;
    let (channels, pre_skip) = head(&first.data)?;
    let ch = if channels >= 2 { Channels::Stereo } else { Channels::Mono };
    let nch = if channels >= 2 { 2 } else { 1 };
    let mut dec = Decoder::new(RATE as u32, ch).map_err(bad)?;
    let mut pcm = vec![0f32; 5760 * nch];
    let mut mono = Vec::with_capacity(5760);
    let (mut decoded, mut given, mut tags) = (0u64, 0u64, false);
    loop {
        let p = match r.read_packet() { Ok(Some(p)) => p, Ok(None) => break, Err(e) => { eprintln!("{}: stops early: {e}", path.display()); break } };
        if !tags { tags = true; if p.data.starts_with(b"OpusTags") { continue } }
        let n = match dec.decode_float(&p.data, &mut pcm, false) { Ok(n) => n, Err(e) => { eprintln!("{}: bad packet: {e}", path.display()); break } };
        mono.clear();
        for i in 0..n { mono.push(if nch == 2 { (pcm[2 * i] + pcm[2 * i + 1]) / 2.0 } else { pcm[i] }) }
        let start = decoded;
        decoded += n as u64;
        // the encoder's look-ahead at the start, and the padding past the end the last page names
        let mut lo = pre_skip.saturating_sub(start).min(n as u64) as usize;
        let mut hi = n;
        if p.last_in_stream() && p.absgp_page() != u64::MAX && p.absgp_page() < decoded {
            hi = (p.absgp_page().saturating_sub(start) as usize).min(n);
        }
        if lo > hi { lo = hi }
        if hi > lo { sink(&mono[lo..hi])?; given += (hi - lo) as u64 }
        if p.last_in_stream() { break }
    }
    Ok(given)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("yogurt-ogg-{}-{}", std::process::id(), crate::random_u32()));
        std::fs::create_dir_all(&d).unwrap();
        d.join(name)
    }
    fn tone(n: usize) -> Vec<f32> { (0..n).map(|i| 0.3 * (i as f32 * 0.05).sin()).collect() }

    #[test]
    fn exact_length_back_whatever_the_frame_boundary() {
        for n in [0usize, 1, 959, 960, 961, 48000, 48000 * 3 + 123] {
            let p = tmp("t.ogg");
            let mut w = OpusWriter::create(&p).unwrap();
            for c in tone(n).chunks(1777) { w.write(c).unwrap() }
            assert_eq!(w.samples(), n as u64);
            w.finish().unwrap();
            assert_eq!(info(&p).unwrap().samples, n as u64, "granule for {n}");
            let mut got = 0u64;
            assert_eq!(decode(&p, |s| { got += s.len() as u64; Ok(()) }).unwrap(), n as u64, "decoded {n}");
            assert_eq!(got, n as u64);
        }
    }

    #[test]
    fn sound_survives_and_lines_up() {
        let p = tmp("t.ogg");
        let mut w = OpusWriter::create(&p).unwrap();
        // a second of silence, then a second of tone: the tone must start about 1 s in
        w.write(&vec![0.0; 48000]).unwrap();
        w.write(&tone(48000)).unwrap();
        w.finish().unwrap();
        let mut all = Vec::new();
        decode(&p, |s| { all.extend_from_slice(s); Ok(()) }).unwrap();
        let first = all.iter().position(|v| v.abs() > 0.05).unwrap();
        assert!((first as i64 - 48000).abs() < 480, "tone starts at {first}");
        let rms = (all[50000..90000].iter().map(|v| v * v).sum::<f32>() / 40000.0).sqrt();
        assert!(rms > 0.15, "rms {rms}");
    }

    #[test]
    fn a_crash_keeps_whole_pages() {
        let p = tmp("t.ogg");
        let mut w = OpusWriter::create(&p).unwrap();
        w.write(&tone(48000 * 3 + 500)).unwrap();
        // never finished: what a crash leaves; the pages written so far are on disk
        drop(w);
        let i = info(&p).unwrap();
        assert!(i.samples >= 48000 * 2 && i.samples <= 48000 * 3 + 500, "kept {}", i.samples);
        let got = decode(&p, |_| Ok(())).unwrap();
        assert!(got >= i.samples - 1000 && got <= i.samples + 1000, "decoded {got} vs {}", i.samples);
        // and cut mid-page
        let bytes = std::fs::read(&p).unwrap();
        std::fs::write(&p, &bytes[..bytes.len() - 7]).unwrap();
        assert!(info(&p).is_ok());
        assert!(decode(&p, |_| Ok(())).is_ok());
    }

    #[test]
    fn not_opus_is_an_error() {
        let p = tmp("x.ogg");
        std::fs::write(&p, b"hello").unwrap();
        assert!(info(&p).is_err());
        assert!(decode(&p, |_| Ok(())).is_err());
    }
}
