//! PulseAudio (and PipeWire through pipewire-pulse): record streams for the mic and the speakers' monitor,
//! and a watcher that keeps the list of sources and the defaults, and says when they change.

use libpulse_binding as pulse;
use libpulse_simple_binding::Simple;
use pulse::callbacks::ListResult;
use pulse::context::subscribe::{Facility, InterestMaskSet, Operation as SubOp};
use pulse::context::{Context, FlagSet as CtxFlags, State as CtxState};
use pulse::def::BufferAttr;
use pulse::mainloop::standard::{IterateResult, Mainloop};
use pulse::operation::State as OpState;
use pulse::sample::{Format, Spec};
use pulse::stream::Direction;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq)]
pub struct Source { pub name: String, pub description: String, pub monitor: bool }

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    /// false until the server answered (or while it is gone)
    pub ready: bool,
    pub default_sink: Option<String>,
    pub default_source: Option<String>,
    pub sources: Vec<Source>,
}

impl Snapshot {
    /// A microphone: a source that is not a monitor of some output
    pub fn mic(&self, name: &str) -> Option<&Source> { self.sources.iter().find(|s| s.name == name && !s.monitor) }
    pub fn mics(&self) -> impl Iterator<Item = &Source> { self.sources.iter().filter(|s| !s.monitor) }
    /// The default input, when it is a real mic (with no mic, PulseAudio makes a monitor the default)
    pub fn default_mic(&self) -> Option<&Source> { self.default_source.as_deref().and_then(|n| self.mic(n)) }
    /// What to record the computer's sound from: the default output's monitor
    pub fn monitor(&self) -> String {
        match &self.default_sink { Some(s) => format!("{s}.monitor"), None => "@DEFAULT_MONITOR@".into() }
    }
}

#[derive(Debug, PartialEq)]
pub enum Change { Sink, Source, Sources }

/// What changed between two snapshots
pub fn changes(a: &Snapshot, b: &Snapshot) -> Vec<Change> {
    let mut out = Vec::new();
    if !a.ready || !b.ready { return out }
    if a.default_sink != b.default_sink { out.push(Change::Sink) }
    if a.default_source != b.default_source { out.push(Change::Source) }
    let names = |s: &Snapshot| s.sources.iter().map(|x| x.name.clone()).collect::<Vec<_>>();
    if names(a) != names(b) { out.push(Change::Sources) }
    out
}

fn connect() -> Option<(Mainloop, Context)> {
    let mut ml = Mainloop::new()?;
    let mut ctx = Context::new(&ml, "Yogurt")?;
    ctx.connect(None, CtxFlags::NOFLAGS, None).ok()?;
    loop {
        match ml.iterate(true) { IterateResult::Success(_) => {}, _ => return None }
        match ctx.get_state() {
            CtxState::Ready => return Some((ml, ctx)),
            CtxState::Failed | CtxState::Terminated => return None,
            _ => {}
        }
    }
}

fn refresh(ml: &mut Mainloop, ctx: &Context) -> Option<Snapshot> {
    let server: Rc<RefCell<Option<(Option<String>, Option<String>)>>> = Rc::new(RefCell::new(None));
    let sources: Rc<RefCell<Vec<Source>>> = Rc::new(RefCell::new(Vec::new()));
    let failed = Rc::new(Cell::new(false));
    let intro = ctx.introspect();
    let s2 = server.clone();
    let op1 = intro.get_server_info(move |i| {
        *s2.borrow_mut() = Some((i.default_sink_name.as_ref().map(|x| x.to_string()), i.default_source_name.as_ref().map(|x| x.to_string())));
    });
    let (l2, f2) = (sources.clone(), failed.clone());
    let op2 = intro.get_source_info_list(move |r| match r {
        ListResult::Item(s) => {
            if let Some(name) = s.name.as_ref() {
                let description = s.description.as_ref().map(|d| d.to_string()).unwrap_or_else(|| name.to_string());
                l2.borrow_mut().push(Source { name: name.to_string(), description, monitor: s.monitor_of_sink.is_some() });
            }
        }
        ListResult::Error => f2.set(true),
        ListResult::End => {}
    });
    while op1.get_state() == OpState::Running || op2.get_state() == OpState::Running {
        match ml.iterate(true) { IterateResult::Success(_) => {}, _ => return None }
        if ctx.get_state() != CtxState::Ready { return None }
    }
    let (default_sink, default_source) = server.borrow_mut().take()?;
    if failed.get() { return None }
    let list = sources.borrow().clone();
    Some(Snapshot { ready: true, default_sink, default_source, sources: list })
}

/// Keeps snap up to date on its own thread and calls on_change after each change; reconnects if the server goes away
/// (pipewire-pulse restarting). Returns once the first answer is in, or after a few seconds without one.
pub fn watch(snap: Arc<Mutex<Snapshot>>, on_change: impl Fn(Change) + Send + 'static) -> bool {
    let (ready_tx, ready_rx) = sync_channel::<bool>(1);
    std::thread::spawn(move || {
        let mut told = false;
        loop {
            if let Some((mut ml, mut ctx)) = connect() {
                let dirty = Rc::new(Cell::new(true));
                let d2 = dirty.clone();
                ctx.set_subscribe_callback(Some(Box::new(move |_: Option<Facility>, _: Option<SubOp>, _: u32| d2.set(true))));
                let _sub = ctx.subscribe(InterestMaskSet::SERVER | InterestMaskSet::SOURCE | InterestMaskSet::SINK, |_| {});
                loop {
                    if dirty.replace(false) {
                        let Some(next) = refresh(&mut ml, &ctx) else { break };
                        let before = std::mem::replace(&mut *snap.lock().unwrap(), next.clone());
                        if !told { told = true; let _ = ready_tx.try_send(true); }
                        for c in changes(&before, &next) { on_change(c) }
                        continue;
                    }
                    match ml.iterate(true) { IterateResult::Success(_) => {}, _ => break }
                    if ctx.get_state() != CtxState::Ready { break }
                }
                eprintln!("lost the sound server: connecting again");
                snap.lock().unwrap().ready = false;
            } else if !told {
                told = true;
                eprintln!("no sound server (PulseAudio or PipeWire)");
                let _ = ready_tx.try_send(false);
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap_or(false)
}

/// A recording stream, read on its own thread in 100 ms buffers of 48 kHz mono
pub struct Capture { stop: Arc<AtomicBool> }
impl Capture {
    pub fn stop(&self) { self.stop.store(true, Ordering::SeqCst) }
}
impl Drop for Capture {
    fn drop(&mut self) { self.stop() }
}

pub const CHUNK: usize = 4800;

/// Opens a record stream on device (None: the default input, which the server moves along when the default
/// changes). on_audio gets each buffer; on_lost once if the stream breaks. None when it can't be opened.
pub fn capture(device: Option<String>, stream_name: &'static str, on_audio: impl Fn(Vec<f32>) + Send + 'static, on_lost: impl FnOnce() + Send + 'static) -> Option<Capture> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let (tx, rx) = sync_channel::<Result<(), String>>(1);
    let label = device.clone().unwrap_or_else(|| "the default input".into());
    std::thread::spawn(move || {
        let spec = Spec { format: Format::F32le, channels: 1, rate: 48000 };
        let bytes = (CHUNK * 4) as u32;
        let attr = BufferAttr { maxlength: u32::MAX, tlength: u32::MAX, prebuf: u32::MAX, minreq: u32::MAX, fragsize: bytes };
        let s = match Simple::new(None, "Yogurt", Direction::Record, device.as_deref(), stream_name, &spec, None, Some(&attr)) {
            Ok(s) => s,
            Err(e) => { let _ = tx.send(Err(e.to_string().unwrap_or_else(|| "unknown error".into()))); return }
        };
        let _ = tx.send(Ok(()));
        let mut raw = vec![0u8; CHUNK * 4];
        while !stop2.load(Ordering::SeqCst) {
            if let Err(e) = s.read(&mut raw) {
                if !stop2.load(Ordering::SeqCst) {
                    eprintln!("{stream_name}: the stream stopped: {}", e.to_string().unwrap_or_default());
                    on_lost();
                }
                return;
            }
            if stop2.load(Ordering::SeqCst) { break }
            on_audio(raw.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect());
        }
    });
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => Some(Capture { stop }),
        Ok(Err(e)) => { eprintln!("{stream_name}: can't record from {label}: {e}"); None }
        Err(_) => { stop.store(true, Ordering::SeqCst); eprintln!("{stream_name}: the sound server did not answer"); None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(name: &str, monitor: bool) -> Source { Source { name: name.into(), description: format!("{name} desc"), monitor } }

    #[test]
    fn mics_leave_out_monitors() {
        let s = Snapshot { ready: true, default_sink: Some("speakers".into()), default_source: Some("speakers.monitor".into()),
            sources: vec![src("speakers.monitor", true), src("usb-mic", false)] };
        assert_eq!(s.mics().map(|m| m.name.as_str()).collect::<Vec<_>>(), vec!["usb-mic"]);
        assert!(s.mic("speakers.monitor").is_none());
        // the default input is the monitor: no mic to record from by default
        assert!(s.default_mic().is_none());
        assert_eq!(s.monitor(), "speakers.monitor");
        assert_eq!(Snapshot::default().monitor(), "@DEFAULT_MONITOR@");
    }

    #[test]
    fn what_changed() {
        let a = Snapshot { ready: true, default_sink: Some("a".into()), default_source: Some("m".into()), sources: vec![src("m", false)] };
        let mut b = a.clone();
        assert!(changes(&a, &b).is_empty());
        b.default_sink = Some("b".into());
        b.sources.push(src("m2", false));
        assert_eq!(changes(&a, &b), vec![Change::Sink, Change::Sources]);
        let mut c = a.clone();
        c.default_source = Some("m2".into());
        assert_eq!(changes(&a, &c), vec![Change::Source]);
        // the first answer, or a reconnect, is not a change
        assert!(changes(&Snapshot::default(), &a).is_empty());
    }
}
