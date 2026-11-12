//! Ogg pages (RFC 3533): written a page at a time, so a crash keeps every page already on disk.

const fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut r = (i as u32) << 24;
        let mut k = 0;
        while k < 8 {
            r = if r & 0x8000_0000 != 0 { (r << 1) ^ 0x04c1_1db7 } else { r << 1 };
            k += 1;
        }
        t[i] = r;
        i += 1;
    }
    t
}
static CRC: [u32; 256] = crc_table();

pub fn crc32(data: &[u8]) -> u32 {
    let mut c = 0u32;
    for &b in data {
        c = (c << 8) ^ CRC[(((c >> 24) as u8) ^ b) as usize];
    }
    c
}

pub const BOS: u8 = 0x02;
pub const EOS: u8 = 0x04;
const CONTINUED: u8 = 0x01;

/// Packets waiting for the next page of one logical stream
pub struct PageWriter {
    serial: u32,
    seq: u32,
    segs: Vec<u8>,
    data: Vec<u8>,
    packets: usize,
}

impl PageWriter {
    pub fn new(serial: u32) -> Self {
        PageWriter { serial, seq: 0, segs: Vec::new(), data: Vec::new(), packets: 0 }
    }

    pub fn packets(&self) -> usize {
        self.packets
    }

    /// Whether a packet this long still fits on the open page (a page holds 255 segments)
    pub fn fits(&self, len: usize) -> bool {
        self.segs.len() + len / 255 + 1 <= 255
    }

    /// Adds a whole packet (callers check fits first; packets here are far smaller than a page)
    pub fn add(&mut self, p: &[u8]) {
        for _ in 0..p.len() / 255 {
            self.segs.push(255);
        }
        self.segs.push((p.len() % 255) as u8);
        self.data.extend_from_slice(p);
        self.packets += 1;
    }

    /// The open page as bytes, with this granule position; the next page starts empty
    pub fn page(&mut self, granule: i64, flags: u8) -> Vec<u8> {
        let mut out = Vec::with_capacity(27 + self.segs.len() + self.data.len());
        out.extend_from_slice(b"OggS");
        out.push(0);
        out.push(flags);
        out.extend_from_slice(&granule.to_le_bytes());
        out.extend_from_slice(&self.serial.to_le_bytes());
        out.extend_from_slice(&self.seq.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.push(self.segs.len() as u8);
        out.extend_from_slice(&self.segs);
        out.extend_from_slice(&self.data);
        let c = crc32(&out);
        out[22..26].copy_from_slice(&c.to_le_bytes());
        self.seq += 1;
        self.segs.clear();
        self.data.clear();
        self.packets = 0;
        out
    }
}

pub struct Page<'a> {
    pub flags: u8,
    pub granule: i64,
    pub segs: &'a [u8],
    pub data: &'a [u8],
}

/// Every whole, intact page from the start; reading stops at the first torn or damaged one (a crash mid-write)
pub fn pages(b: &[u8]) -> Vec<Page<'_>> {
    let mut out = Vec::new();
    let mut at = 0;
    while b.len() >= at + 27 && &b[at..at + 4] == b"OggS" && b[at + 4] == 0 {
        let nseg = b[at + 26] as usize;
        if b.len() < at + 27 + nseg {
            break;
        }
        let segs = &b[at + 27..at + 27 + nseg];
        let len: usize = segs.iter().map(|&x| x as usize).sum();
        let end = at + 27 + nseg + len;
        if b.len() < end {
            break;
        }
        let mut copy = b[at..end].to_vec();
        copy[22..26].fill(0);
        let want = u32::from_le_bytes([b[at + 22], b[at + 23], b[at + 24], b[at + 25]]);
        if crc32(&copy) != want {
            break;
        }
        let mut g = [0u8; 8];
        g.copy_from_slice(&b[at + 6..at + 14]);
        out.push(Page { flags: b[at + 5], granule: i64::from_le_bytes(g), segs, data: &b[at + 27 + nseg..end] });
        at = end;
    }
    out
}

/// The packets on these pages, joined across page boundaries
pub fn packets(pages: &[Page<'_>]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut cur: Vec<u8> = Vec::new();
    let mut open = false;
    for p in pages {
        if open && p.flags & CONTINUED == 0 {
            cur.clear();
            open = false;
        }
        let mut off = 0;
        for &s in p.segs {
            cur.extend_from_slice(&p.data[off..off + s as usize]);
            off += s as usize;
            if s < 255 {
                out.push(std::mem::take(&mut cur));
                open = false;
            } else {
                open = true;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_matches_the_ogg_reference() {
        // the CRC of "123456789" with Ogg's parameters (poly 0x04c11db7, no reflection, init 0, no final xor)
        assert_eq!(crc32(b"123456789"), 0x89a1_897f);
    }

    #[test]
    fn pages_round_trip_packets_of_any_size() {
        let mut w = PageWriter::new(7);
        let sizes = [0usize, 1, 254, 255, 256, 510, 1000];
        let mut bytes = Vec::new();
        for (i, &n) in sizes.iter().enumerate() {
            let p: Vec<u8> = (0..n).map(|k| (k + i) as u8).collect();
            assert!(w.fits(n));
            w.add(&p);
            if i % 3 == 2 {
                bytes.extend(w.page(i as i64, 0));
            }
        }
        bytes.extend(w.page(99, EOS));
        let ps = pages(&bytes);
        assert_eq!(ps.len(), 3);
        assert_eq!(ps.last().unwrap().granule, 99);
        assert_eq!(ps.last().unwrap().flags, EOS);
        let got = packets(&ps);
        assert_eq!(got.len(), sizes.len());
        for (i, &n) in sizes.iter().enumerate() {
            assert_eq!(got[i].len(), n);
            assert!(got[i].iter().enumerate().all(|(k, &b)| b == (k + i) as u8));
        }
    }

    #[test]
    fn a_torn_last_page_is_left_out() {
        let mut w = PageWriter::new(1);
        w.add(&[1, 2, 3]);
        let mut bytes = w.page(10, BOS);
        w.add(&[4, 5, 6]);
        let second = w.page(20, 0);
        bytes.extend_from_slice(&second[..second.len() - 1]);
        let ps = pages(&bytes);
        assert_eq!(ps.len(), 1);
        assert_eq!(ps[0].granule, 10);
        // damaged bytes are refused too
        let mut bad = w.page(30, 0);
        let last = bad.len() - 1;
        bad[last] ^= 0xff;
        assert!(pages(&bad).is_empty());
    }

    #[test]
    fn a_page_holds_at_most_255_segments() {
        let mut w = PageWriter::new(1);
        for _ in 0..255 {
            assert!(w.fits(10));
            w.add(&[0; 10]);
        }
        assert!(!w.fits(10));
    }
}
