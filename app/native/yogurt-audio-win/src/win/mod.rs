//! WASAPI: microphones, the computer's sound (process loopback that leaves Yogurt out, else the whole output), device events.
//! Shared mode only, never the communications role or exclusive mode, so a call app keeps its mic just as it was.
#![allow(non_snake_case)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::{implement, w, Interface, Ref, Result as WinResult, HRESULT, HSTRING, IUnknown, PCWSTR};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::{CloseHandle, E_ACCESSDENIED, E_FAIL, HANDLE, PROPERTYKEY, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, IAgileObject, IAgileObject_Impl, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Threading::{CreateEventW, GetCurrentProcessId, SetEvent, WaitForSingleObject};

use crate::gap::GapFiller;
use crate::out::log;

/// What the capture threads and Windows tell the recorder
pub enum Ev {
    Mic(Vec<f32>),
    MicLost,
    /// the computer's sound and the meeting time it was heard at
    Sys(Vec<f32>, f64),
    SysLost,
    /// the default output (true) or input changed
    Default(bool),
    /// some device came, went or changed state
    Devices,
    Cmd(String),
    Eof,
}

/// Meeting time: ms since the helper started, on the same clock as WASAPI's QPC buffer times
#[derive(Clone, Copy)]
pub struct Clock {
    start: Instant,
    start_hns: u64,
}

impl Clock {
    pub fn new() -> Clock {
        let start = Instant::now();
        Clock { start, start_hns: qpc_hns() }
    }
    pub fn now_ms(&self) -> f64 {
        self.start.elapsed().as_secs_f64() * 1000.0
    }
    /// a buffer's QPC position (100 ns units) as meeting time
    pub fn qpc_ms(&self, hns: u64) -> f64 {
        (hns as f64 - self.start_hns as f64) / 10_000.0
    }
}

fn qpc_hns() -> u64 {
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    let (mut c, mut f) = (0i64, 0i64);
    unsafe {
        let _ = QueryPerformanceCounter(&mut c);
        let _ = QueryPerformanceFrequency(&mut f);
    }
    if f <= 0 {
        return 0;
    }
    ((c as i128 * 10_000_000) / f as i128) as u64
}

pub fn com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn enumerator() -> WinResult<IMMDeviceEnumerator> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
}

pub fn device_id(d: &IMMDevice) -> Option<String> {
    unsafe {
        let p = d.GetId().ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }
}

pub fn friendly_name(d: &IMMDevice) -> Option<String> {
    unsafe {
        let store = d.OpenPropertyStore(STGM_READ).ok()?;
        let v: PROPVARIANT = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
        let s = v.to_string();
        if s.trim().is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

pub fn default_input() -> Option<IMMDevice> {
    unsafe { enumerator().ok()?.GetDefaultAudioEndpoint(eCapture, eConsole).ok() }
}

/// The microphone with this ID, if it is plugged in and on now
pub fn mic_device(uid: &str) -> Option<IMMDevice> {
    unsafe {
        let d = enumerator().ok()?.GetDevice(&HSTRING::from(uid)).ok()?;
        if d.GetState().ok()? != DEVICE_STATE_ACTIVE {
            return None;
        }
        let ep: IMMEndpoint = d.cast().ok()?;
        if ep.GetDataFlow().ok()? != eCapture {
            return None;
        }
        Some(d)
    }
}

/// Every microphone that is on, and whether it is Windows' default input
pub fn mic_devices() -> Vec<(String, String, bool)> {
    let mut out = Vec::new();
    let Ok(e) = enumerator() else { return out };
    let default = default_input().as_ref().and_then(device_id);
    unsafe {
        let Ok(list) = e.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) else { return out };
        let n = list.GetCount().unwrap_or(0);
        for i in 0..n {
            let Ok(d) = list.Item(i) else { continue };
            let (Some(id), Some(name)) = (device_id(&d), friendly_name(&d)) else { continue };
            let is_default = default.as_deref() == Some(id.as_str());
            out.push((id, name, is_default));
        }
    }
    out
}

/// Why a stream could not start
#[derive(Debug, PartialEq)]
pub enum StartError {
    /// Windows' microphone privacy setting is off for desktop apps
    Denied,
    NoDevice,
    Failed(String),
}

fn start_error(e: windows::core::Error) -> StartError {
    if e.code() == E_ACCESSDENIED {
        StartError::Denied
    } else {
        StartError::Failed(format!("{e}"))
    }
}

/// 48 kHz float in the channels asked for; Windows converts whatever the device runs at (AUTOCONVERTPCM)
fn format(channels: u16) -> WAVEFORMATEX {
    WAVEFORMATEX {
        wFormatTag: 3, // WAVE_FORMAT_IEEE_FLOAT
        nChannels: channels,
        nSamplesPerSec: 48_000,
        nAvgBytesPerSec: 48_000 * 4 * channels as u32,
        nBlockAlign: 4 * channels,
        wBitsPerSample: 32,
        cbSize: 0,
    }
}

/// Shared mode, 200 ms buffer; mono first, stereo where the stream refuses mono. Returns the channel count.
fn initialize(client: &IAudioClient, loopback: bool) -> WinResult<u16> {
    let mut flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    if loopback {
        flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;
    }
    let mut last = None;
    for ch in [1u16, 2] {
        let f = format(ch);
        match unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2_000_000, 0, &f, None) } {
            Ok(()) => return Ok(ch),
            Err(e) => {
                if e.code() == E_ACCESSDENIED {
                    return Err(e);
                }
                last = Some(e)
            }
        }
    }
    Err(last.unwrap_or_else(|| E_FAIL.into()))
}

/// A running capture thread; stopping waits for it
pub struct Stream {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Stream {
    pub fn stop(mut self) {
        self.halt();
    }
    fn halt(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.halt();
    }
}

const POLL: Duration = Duration::from_millis(10);

/// One packet: 48 kHz mono samples, its QPC time (0 when the device has none)
fn read_packet(cap: &IAudioCaptureClient, channels: u16) -> WinResult<Option<(Vec<f32>, u64)>> {
    unsafe {
        if cap.GetNextPacketSize()? == 0 {
            return Ok(None);
        }
        let mut data: *mut u8 = std::ptr::null_mut();
        let (mut frames, mut flags, mut qpc) = (0u32, 0u32, 0u64);
        cap.GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc as *mut u64))?;
        let n = frames as usize;
        let ch = channels as usize;
        // AUDCLNT_BUFFERFLAGS_SILENT
        let samples: Vec<f32> = if flags & 2 != 0 || data.is_null() {
            vec![0.0; n]
        } else {
            let all = std::slice::from_raw_parts(data as *const f32, n * ch);
            if ch == 1 {
                all.to_vec()
            } else {
                all.chunks_exact(ch).map(|c| c.iter().sum::<f32>() / ch as f32).collect()
            }
        };
        cap.ReleaseBuffer(frames)?;
        // AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR
        let qpc = if flags & 4 != 0 { 0 } else { qpc };
        Ok(Some((samples, qpc)))
    }
}

/// Starts a stream on its own thread; the thread reports whether it got going before this returns
fn spawn(
    setup: impl FnOnce() -> Result<(IAudioClient, u16, bool), StartError> + Send + 'static,
    each: impl FnMut(Option<(Vec<f32>, u64)>) + Send + 'static,
    lost: impl FnOnce() + Send + 'static,
) -> Result<Stream, StartError> {
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = channel::<Result<bool, StartError>>();
    let s = stop.clone();
    let thread = std::thread::spawn(move || {
        com();
        let mut each = each;
        let (client, ch, excl) = match setup() {
            Ok(x) => x,
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                return;
            }
        };
        let cap: IAudioCaptureClient = match unsafe { client.GetService() } {
            Ok(c) => c,
            Err(e) => {
                let _ = ready_tx.send(Err(start_error(e)));
                return;
            }
        };
        if let Err(e) = unsafe { client.Start() } {
            let _ = ready_tx.send(Err(start_error(e)));
            return;
        }
        let _ = ready_tx.send(Ok(excl));
        'run: while !s.load(Ordering::SeqCst) {
            std::thread::sleep(POLL);
            let mut got = false;
            loop {
                match read_packet(&cap, ch) {
                    Ok(Some(p)) => {
                        got = true;
                        each(Some(p))
                    }
                    Ok(None) => break,
                    Err(e) => {
                        if !s.load(Ordering::SeqCst) {
                            log(&format!("audio stream stopped: {e}"));
                            lost();
                        }
                        break 'run;
                    }
                }
            }
            if !got {
                each(None);
            }
        }
        unsafe {
            let _ = client.Stop();
        }
    });
    match ready_rx.recv() {
        Ok(Ok(_)) => Ok(Stream { stop, thread: Some(thread) }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => {
            let _ = thread.join();
            Err(StartError::Failed("the audio thread ended".into()))
        }
    }
}

/// The microphone: the one with this ID, or Windows' default input
pub fn start_mic(uid: Option<String>, tx: Sender<Ev>) -> Result<Stream, StartError> {
    let lost_tx = tx.clone();
    spawn(
        move || {
            let dev = match &uid {
                Some(u) => mic_device(u),
                None => default_input(),
            }
            .ok_or(StartError::NoDevice)?;
            let client: IAudioClient = unsafe { dev.Activate(CLSCTX_ALL, None) }.map_err(start_error)?;
            let ch = initialize(&client, false).map_err(start_error)?;
            Ok((client, ch, false))
        },
        move |p| {
            if let Some((s, _)) = p {
                let _ = tx.send(Ev::Mic(s));
            }
        },
        move || {
            let _ = lost_tx.send(Ev::MicLost);
        },
    )
}

/// The computer's sound. Process loopback (Windows 10 2004 and newer) records every app except Yogurt: the app that
/// started this helper and everything it started. Where that can't start, the whole output is recorded, Yogurt included.
pub fn start_system(tx: Sender<Ev>, clock: Clock) -> Result<Stream, StartError> {
    let lost_tx = tx.clone();
    let mut gap = GapFiller::new(clock.now_ms());
    spawn(
        move || {
            let parent = parent_pid();
            // YOGURT_AUDIO_LOOPBACK=endpoint: the fallback on purpose (CI tests it)
            if parent != 0 && std::env::var("YOGURT_AUDIO_LOOPBACK").as_deref() != Ok("endpoint") {
                match process_loopback(parent) {
                    Ok(client) => match initialize(&client, true) {
                        Ok(ch) => {
                            log("system audio: every app except Yogurt");
                            return Ok((client, ch, true));
                        }
                        Err(e) => log(&format!("process loopback didn't start ({e}): recording the whole output")),
                    },
                    Err(e) => log(&format!("process loopback isn't available ({e}): recording the whole output")),
                }
            }
            let dev = unsafe { enumerator().map_err(start_error)?.GetDefaultAudioEndpoint(eRender, eConsole) }.map_err(|_| StartError::NoDevice)?;
            let client: IAudioClient = unsafe { dev.Activate(CLSCTX_ALL, None) }.map_err(start_error)?;
            let ch = initialize(&client, true).map_err(start_error)?;
            log("system audio: the whole output, Yogurt's own sound included");
            Ok((client, ch, false))
        },
        move |p| match p {
            Some((s, qpc)) => {
                let frames = s.len();
                let heard = if qpc != 0 { clock.qpc_ms(qpc) } else { clock.now_ms() - frames as f64 / 48.0 };
                let skip = gap.packet(heard, frames);
                if skip < frames {
                    let _ = tx.send(Ev::Sys(s[skip..].to_vec(), heard + skip as f64 / 48.0));
                }
            }
            None => {
                if let Some((at, frames)) = gap.idle(clock.now_ms()) {
                    let _ = tx.send(Ev::Sys(vec![0.0; frames], at));
                }
            }
        },
        move || {
            let _ = lost_tx.send(Ev::SysLost);
        },
    )
}

/// The process that started this helper (Yogurt's main process)
pub fn parent_pid() -> u32 {
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return 0 };
        let me = GetCurrentProcessId();
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = 0;
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                if e.th32ProcessID == me {
                    found = e.th32ParentProcessID;
                    break;
                }
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        found
    }
}

#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct Activated(HANDLE);

impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
    fn ActivateCompleted(&self, _op: Ref<'_, IActivateAudioInterfaceAsyncOperation>) -> WinResult<()> {
        unsafe { SetEvent(self.0) }
    }
}

impl IAgileObject_Impl for Activated_Impl {}

/// PROPVARIANT holding a BLOB, laid out as on x64
#[repr(C)]
struct BlobVariant {
    vt: u16,
    r1: u16,
    r2: u16,
    r3: u16,
    size: u32,
    data: *const std::ffi::c_void,
}

fn process_loopback(pid: u32) -> WinResult<IAudioClient> {
    unsafe {
        let params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };
        let blob = BlobVariant {
            vt: 65, // VT_BLOB
            r1: 0,
            r2: 0,
            r3: 0,
            size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            data: &params as *const _ as *const _,
        };
        let done = CreateEventW(None, true, false, PCWSTR::null())?;
        let handler: IActivateAudioInterfaceCompletionHandler = Activated(done).into();
        let op = ActivateAudioInterfaceAsync(
            w!("VAD\\Process_Loopback"),
            &IAudioClient::IID,
            Some(&blob as *const BlobVariant as *const PROPVARIANT),
            &handler,
        );
        let op = match op {
            Ok(op) => op,
            Err(e) => {
                let _ = CloseHandle(done);
                return Err(e);
            }
        };
        let waited = WaitForSingleObject(done, 5_000);
        let _ = CloseHandle(done);
        if waited != WAIT_OBJECT_0 {
            return Err(E_FAIL.into());
        }
        let mut hr = HRESULT(0);
        let mut unk: Option<IUnknown> = None;
        op.GetActivateResult(&mut hr, &mut unk)?;
        hr.ok()?;
        unk.ok_or_else(|| windows::core::Error::from(E_FAIL))?.cast()
    }
}

#[implement(IMMNotificationClient)]
struct Watcher(Sender<Ev>);

impl IMMNotificationClient_Impl for Watcher_Impl {
    fn OnDeviceStateChanged(&self, _id: &PCWSTR, _state: DEVICE_STATE) -> WinResult<()> {
        let _ = self.0.send(Ev::Devices);
        Ok(())
    }
    fn OnDeviceAdded(&self, _id: &PCWSTR) -> WinResult<()> {
        let _ = self.0.send(Ev::Devices);
        Ok(())
    }
    fn OnDeviceRemoved(&self, _id: &PCWSTR) -> WinResult<()> {
        let _ = self.0.send(Ev::Devices);
        Ok(())
    }
    fn OnDefaultDeviceChanged(&self, flow: EDataFlow, role: ERole, _id: &PCWSTR) -> WinResult<()> {
        if role == eConsole {
            let _ = self.0.send(Ev::Default(flow == eRender));
        }
        Ok(())
    }
    fn OnPropertyValueChanged(&self, _id: &PCWSTR, _key: &PROPERTYKEY) -> WinResult<()> {
        Ok(())
    }
}

/// Device events for as long as this is kept
pub struct Watch {
    e: IMMDeviceEnumerator,
    client: IMMNotificationClient,
}

pub fn watch(tx: Sender<Ev>) -> Option<Watch> {
    let e = enumerator().ok()?;
    let client: IMMNotificationClient = Watcher(tx).into();
    unsafe { e.RegisterEndpointNotificationCallback(&client).ok()? };
    Some(Watch { e, client })
}

impl Drop for Watch {
    fn drop(&mut self) {
        unsafe {
            let _ = self.e.UnregisterEndpointNotificationCallback(&self.client);
        }
    }
}
