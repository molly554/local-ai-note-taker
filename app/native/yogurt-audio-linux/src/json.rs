//! Just enough JSON for the helper's lines: keys come out sorted, like the Mac helper's (JSONSerialization .sortedKeys).

use std::collections::BTreeMap;

pub enum J {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(BTreeMap<String, J>),
}

pub fn obj<const N: usize>(pairs: [(&str, J); N]) -> J {
    J::Obj(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}
pub fn s(v: &str) -> J { J::Str(v.to_string()) }
pub fn n(v: f64) -> J { J::Num(v) }
pub fn opt(v: Option<&str>) -> J { v.map(s).unwrap_or(J::Null) }

pub fn esc(v: &str) -> String {
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

fn num(v: f64) -> String {
    if !v.is_finite() { return "null".into() }
    // whole numbers without a fraction, as JSONSerialization writes them
    if v.fract() == 0.0 && v.abs() < 1e15 { return format!("{}", v as i64) }
    format!("{}", v)
}

impl J {
    pub fn text(&self) -> String {
        match self {
            J::Null => "null".into(),
            J::Bool(b) => b.to_string(),
            J::Num(v) => num(*v),
            J::Str(v) => esc(v),
            J::Arr(a) => format!("[{}]", a.iter().map(|x| x.text()).collect::<Vec<_>>().join(",")),
            J::Obj(m) => format!("{{{}}}", m.iter().map(|(k, v)| format!("{}:{}", esc(k), v.text())).collect::<Vec<_>>().join(",")),
        }
    }
}

/// The number after "key": in a small JSON object (part.N.json's startMs), without a full parser
pub fn number_field(text: &str, key: &str) -> Option<f64> {
    let at = text.find(&esc(key))? + key.len() + 2;
    let rest = text[at..].trim_start().strip_prefix(':')?.trim_start();
    let end = rest.find(|c: char| !(c.is_ascii_digit() || "+-.eE".contains(c))).unwrap_or(rest.len());
    rest[..end].parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorted_keys_and_whole_numbers() {
        let line = obj([("t", s("pcm")), ("track", s("me")), ("ms", n(1200.0)), ("n", n(1600.0))]).text();
        assert_eq!(line, r#"{"ms":1200,"n":1600,"t":"pcm","track":"me"}"#);
        assert_eq!(obj([("me", n(0.123)), ("them", n(0.0))]).text(), r#"{"me":0.123,"them":0}"#);
    }

    #[test]
    fn escapes_names() {
        assert_eq!(esc("Mic \"USB\"\\\n\u{1}é"), r#""Mic \"USB\"\\\n\u0001é""#);
        assert_eq!(obj([("uid", J::Null), ("name", opt(Some("A")))]).text(), r#"{"name":"A","uid":null}"#);
    }

    #[test]
    fn reads_start_ms() {
        assert_eq!(number_field(r#"{"startMs":61234}"#, "startMs"), Some(61234.0));
        assert_eq!(number_field(r#"{ "startMs" : 12.5 }"#, "startMs"), Some(12.5));
        assert_eq!(number_field(r#"{"other":1}"#, "startMs"), None);
    }
}
