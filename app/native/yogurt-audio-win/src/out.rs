//! stdout: JSON lines, a pcm line followed by its float32 samples. Keys are sorted, as the Swift helper writes them.
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

static BROKEN: AtomicBool = AtomicBool::new(false);
static LOCK: Mutex<()> = Mutex::new(());

/// Problems go to stderr (unbuffered), which Yogurt writes to its log
pub fn log(s: &str) {
    eprintln!("{s}");
}

pub fn fail(s: &str) -> ! {
    log(s);
    std::process::exit(1)
}

/// A JSON string literal
pub fn s(v: &str) -> String {
    let mut o = String::with_capacity(v.len() + 2);
    o.push('"');
    for c in v.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// A string or null
pub fn opt(v: Option<&str>) -> String {
    v.map(s).unwrap_or_else(|| "null".into())
}

/// A JSON number: whole numbers without a fraction, as JSONSerialization writes them
pub fn n(v: f64) -> String {
    if !v.is_finite() {
        return "0".into();
    }
    if v == v.trunc() && v.abs() < 1e15 {
        return format!("{}", v as i64);
    }
    format!("{v}")
}

/// Writes one message; false once Yogurt has gone (the pipe closed)
pub fn send(json: &str, payload: Option<&[f32]>) -> bool {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut buf = Vec::with_capacity(json.len() + 1 + payload.map_or(0, |p| p.len() * 4));
    buf.extend_from_slice(json.as_bytes());
    buf.push(b'\n');
    if let Some(p) = payload {
        for x in p {
            buf.extend_from_slice(&x.to_le_bytes());
        }
    }
    let mut o = std::io::stdout().lock();
    let ok = o.write_all(&buf).and_then(|_| o.flush()).is_ok();
    if !ok {
        BROKEN.store(true, Ordering::SeqCst);
    }
    ok
}

pub fn broken() -> bool {
    BROKEN.load(Ordering::SeqCst)
}

pub fn warn(code: &str) {
    send(&format!("{{\"code\":{},\"t\":\"warn\"}}", s(code)), None);
}

pub fn level(me: f64, them: f64) {
    send(&format!("{{\"me\":{},\"t\":\"level\",\"them\":{}}}", n(me), n(them)), None);
}

pub fn pcm(track: &str, ms: i64, samples: &[f32]) {
    send(&format!("{{\"ms\":{},\"n\":{},\"t\":\"pcm\",\"track\":{}}}", ms, samples.len(), s(track)), Some(samples));
}

pub fn mic(uid: Option<&str>, name: Option<&str>) {
    send(&format!("{{\"name\":{},\"t\":\"mic\",\"uid\":{}}}", opt(name), opt(uid)), None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_are_escaped() {
        assert_eq!(s("a\"b\\c\nd\u{1}"), "\"a\\\"b\\\\c\\nd\\u0001\"");
        assert_eq!(s("Mikrofon (Realtek® Audio)"), "\"Mikrofon (Realtek® Audio)\"");
        assert_eq!(opt(None), "null");
    }

    #[test]
    fn numbers_read_like_the_mac_helper() {
        assert_eq!(n(0.0), "0");
        assert_eq!(n(1.0), "1");
        assert_eq!(n(0.123), "0.123");
        assert_eq!(n(20000.0), "20000");
        assert_eq!(n(f64::NAN), "0");
    }
}
