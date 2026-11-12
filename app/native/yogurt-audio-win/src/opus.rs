//! libopus, 48 kHz mono (linked by audiopus_sys)
use std::os::raw::{c_int, c_void};

use audiopus_sys as _;

extern "C" {
    fn opus_encoder_create(fs: i32, channels: c_int, application: c_int, error: *mut c_int) -> *mut c_void;
    fn opus_encoder_ctl(st: *mut c_void, request: c_int, ...) -> c_int;
    fn opus_encode_float(st: *mut c_void, pcm: *const f32, frame_size: c_int, data: *mut u8, max_data_bytes: i32) -> i32;
    fn opus_encoder_destroy(st: *mut c_void);
    fn opus_decoder_create(fs: i32, channels: c_int, error: *mut c_int) -> *mut c_void;
    fn opus_decode_float(st: *mut c_void, data: *const u8, len: i32, pcm: *mut f32, frame_size: c_int, decode_fec: c_int) -> c_int;
    fn opus_decoder_destroy(st: *mut c_void);
}

const APPLICATION_AUDIO: c_int = 2049;
const SET_BITRATE: c_int = 4002;
const GET_LOOKAHEAD: c_int = 4027;
const SET_SIGNAL: c_int = 4024;
const SIGNAL_VOICE: c_int = 3001;

/// 20 ms at 48 kHz
pub const FRAME: usize = 960;
/// About the size of the Mac's HE-AAC 16 kb/s files, and the same as the Linux recorder's
pub const BITRATE: i32 = 20_000;

pub struct Encoder(*mut c_void);
unsafe impl Send for Encoder {}

impl Encoder {
    pub fn new() -> Option<Encoder> {
        let mut err = 0;
        let st = unsafe { opus_encoder_create(48_000, 1, APPLICATION_AUDIO, &mut err) };
        if st.is_null() || err != 0 {
            return None;
        }
        unsafe {
            opus_encoder_ctl(st, SET_BITRATE, BITRATE);
            opus_encoder_ctl(st, SET_SIGNAL, SIGNAL_VOICE);
        }
        Some(Encoder(st))
    }

    /// Samples the decoder drops at the start (Ogg Opus pre-skip)
    pub fn lookahead(&self) -> u16 {
        let mut v: i32 = 0;
        unsafe { opus_encoder_ctl(self.0, GET_LOOKAHEAD, &mut v as *mut i32) };
        v.clamp(0, 48_000) as u16
    }

    /// One 20 ms frame into a packet
    pub fn encode(&mut self, frame: &[f32]) -> Option<Vec<u8>> {
        debug_assert_eq!(frame.len(), FRAME);
        let mut out = [0u8; 1500];
        let n = unsafe { opus_encode_float(self.0, frame.as_ptr(), FRAME as c_int, out.as_mut_ptr(), out.len() as i32) };
        if n < 0 {
            return None;
        }
        Some(out[..n as usize].to_vec())
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe { opus_encoder_destroy(self.0) }
    }
}

pub struct Decoder(*mut c_void);
unsafe impl Send for Decoder {}

impl Decoder {
    pub fn new() -> Option<Decoder> {
        let mut err = 0;
        let st = unsafe { opus_decoder_create(48_000, 1, &mut err) };
        if st.is_null() || err != 0 {
            return None;
        }
        Some(Decoder(st))
    }

    /// A packet's samples (up to 120 ms), None when it is damaged
    pub fn decode(&mut self, packet: &[u8]) -> Option<Vec<f32>> {
        let mut out = vec![0f32; 5760];
        let n = unsafe { opus_decode_float(self.0, packet.as_ptr(), packet.len() as i32, out.as_mut_ptr(), 5760, 0) };
        if n < 0 {
            return None;
        }
        out.truncate(n as usize);
        Some(out)
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe { opus_decoder_destroy(self.0) }
    }
}
