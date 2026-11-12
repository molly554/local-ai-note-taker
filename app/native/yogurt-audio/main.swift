// Yogurt's recorder: the microphone (AVAudioEngine, shared with the call app: no voice processing, which silenced
// Zoom's mic) and the computer's sound (a Core Audio process tap on every process except Yogurt,
// macOS 14.2+; the audio-capture permission needs 14.4). Yogurt never joins the call.
//   yogurt-audio record --dir DIR [--part N --start-ms X] [--mic UID]
//   yogurt-audio join --dir DIR
// A restart after a crash is part N (N >= 1) and carries on at meeting time X: it writes DIR/me.N.m4a and DIR/them.N.m4a,
// whose file time starts at X, and its pcm ms continue from X. Existing parts are never deleted.
// join stitches me.m4a, me.1.m4a, ... (and them) into one me.m4a and one them.m4a on meeting time (silence in the gaps),
// and removes the part files only after the export worked.
// Writes DIR/me.m4a and DIR/them.m4a (HE-AAC 16 kb/s mono, 48 kHz or 32 kHz), in 5 s movie fragments so a crash keeps what was recorded.
// File time is meeting time on both: gaps (startup, pause, device switches) are written as silence.
// stdout: JSON lines; a pcm line is followed by n float32 little-endian samples (16 kHz mono).
//   {"t":"pcm","track":"me"|"them","ms":<startMs>,"n":<samples>}
//   {"t":"level","me":0..1,"them":0..1}        10 times a second
//   {"t":"warn","code":"no-system-audio"|"device-changed"|"no-mic"|"mic-gone"}   mic-gone: the chosen mic went away, back to the Mac's own
//   {"t":"mic","uid":string|null,"name":string|null}   the mic recording now, after each start: uid null is Auto (the Mac's default input)
//   {"t":"speech","track":"me"|"them","final":bool,"startMs","endMs","text","words":[{"text","startMs","endMs"}]}  Apple's on-device speech (record --speech LOCALE, macOS 26)
// yogurt-audio speech-locales → {"available","supported":[bcp47],"installed":[bcp47]}; speech-install LOCALE → {"installed":bool}
// stdin: pause, resume, stop (end of input also stops), mic UID or mic auto (switch without stopping). Problems go to stderr.
import AVFoundation
import Speech
import CoreAudio
import Darwin
import Foundation

signal(SIGPIPE, SIG_IGN)
setvbuf(stderr, nil, _IONBF, 0)

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
func fail(_ s: String) -> Never { log(s); exit(1) }

// MARK: output

let outQ = DispatchQueue(label: "yogurt.out")
/// all audio work runs here, so tracks, pause and rebuilds never race
let work = DispatchQueue(label: "yogurt.work")
let started = Date()
let args = CommandLine.arguments
/// this run's part of the meeting's files (0: the first) and the meeting time it starts at
let part = Int(args.firstIndex(of: "--part").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? "0") ?? 0
let startOffsetMs = Double(args.firstIndex(of: "--start-ms").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? "0") ?? 0
func nowMs() -> Double { Date().timeIntervalSince(started) * 1000 }
/// a Core Audio host time on the same clock as nowMs
let startedHost = mach_absolute_time()
let hostMsPerTick: Double = { var tb = mach_timebase_info_data_t(); mach_timebase_info(&tb); return Double(tb.numer) / Double(tb.denom) / 1e6 }()
func hostMs(_ host: UInt64) -> Double { (Double(host) - Double(startedHost)) * hostMsPerTick }

func writeAll(_ d: Data) -> Bool {
  d.withUnsafeBytes { (p: UnsafeRawBufferPointer) -> Bool in
    var off = 0
    while off < p.count {
      let r = Darwin.write(1, p.baseAddress! + off, p.count - off)
      if r < 0 { if errno == EINTR { continue }; return false }
      off += r
    }
    return true
  }
}
func send(_ obj: [String: Any], payload: Data? = nil) {
  var d = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
  d.append(10)
  if let payload { d.append(payload) }
  // Yogurt gone: finish the files and leave
  outQ.async { if !writeAll(d) { work.async { recorder.finish() } } }
}

// MARK: one track: a file and a stream

let mono16 = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
let mono48 = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false)!

/// Any float buffer down to one channel; the mic takes its first channel (a many-channel interface's first input)
func mono(_ b: AVAudioPCMBuffer, firstOnly: Bool) -> AVAudioPCMBuffer? {
  let n = Int(b.frameLength)
  guard n > 0, let src = b.floatChannelData,
        let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: b.format.sampleRate, channels: 1, interleaved: false),
        let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(n)) else { return nil }
  out.frameLength = AVAudioFrameCount(n)
  let use = firstOnly ? 1 : max(1, Int(b.format.channelCount))
  let inter = b.format.isInterleaved && b.format.channelCount > 1, stride = b.stride
  let dst = out.floatChannelData![0]
  for i in 0..<n {
    var s: Float = 0
    for c in 0..<use { s += inter ? src[0][i * stride + c] : src[c][i] }
    dst[i] = s / Float(use)
  }
  return out
}

func convert(_ conv: AVAudioConverter, _ buf: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
  let cap = AVAudioFrameCount(Double(buf.frameLength) * conv.outputFormat.sampleRate / buf.format.sampleRate) + 256
  guard let out = AVAudioPCMBuffer(pcmFormat: conv.outputFormat, frameCapacity: cap) else { return nil }
  var given = false
  var err: NSError?
  let st = conv.convert(to: out, error: &err) { _, status in
    if given { status.pointee = .noDataNow; return nil }
    given = true; status.pointee = .haveData; return buf
  }
  if st == .error { log("convert failed: \(err?.localizedDescription ?? "")"); return nil }
  return out
}

final class Track {
  let name: String
  let url: URL
  var writer: AVAssetWriter?
  var input: AVAssetWriterInput?
  var conv16: AVAudioConverter?, conv48: AVAudioConverter?
  var srcRate: Double = 0
  var pts: Int64 = 0
  // the stream's timeline: meeting time when this run of audio began, and samples sent since
  var baseMs: Double? = nil
  var sentSince: Int64 = 0
  var pending: [Float] = []
  /// meeting time the device's last buffer ended at, when it says (the computer's sound does)
  var lastHeardEnd: Double?
  var sumSq: Double = 0, count = 0
  /// false: no pcm frames out (speech-file --live feeds Apple's speech only)
  var stream = true

  /// false for a file this run did not start (never delete what is already there)
  let fresh: Bool
  /// the 16 kHz audio with the meeting time it starts at (Apple speech listens here too)
  var onPcm16: ((AVAudioPCMBuffer, Double) -> Void)?

  init(_ name: String, dir: URL) { self.name = name; fresh = part == 0; url = dir.appendingPathComponent(part == 0 ? "\(name).m4a" : "\(name).\(part).m4a") }
  /// a track that writes to a given file (join)
  init(_ name: String, file: URL) { self.name = name; fresh = true; url = file }

  func openWriter() {
    // part 0 starts a meeting's folder fresh; a later part never touches what is there
    if fresh { try? FileManager.default.removeItem(at: url) }
    // HE-AAC keeps the same playable container and crash-safe fragments. Some encoders require 32 kHz.
    for rate in [48000, 32000] {
      guard let w = try? AVAssetWriter(outputURL: url, fileType: .m4a) else { log("can't write \(url.path)"); return }
      w.movieFragmentInterval = CMTime(value: 5, timescale: 1)
      w.shouldOptimizeForNetworkUse = false
      let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC_HE, AVSampleRateKey: rate,
                                    AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 16000]
      guard w.canApply(outputSettings: settings, forMediaType: .audio) else { continue }
      let i = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
      i.expectsMediaDataInRealTime = true
      guard w.canAdd(i) else { continue }
      w.add(i)
      guard w.startWriting() else { log("can't start HE-AAC at \(rate): \(w.error?.localizedDescription ?? "")"); try? FileManager.default.removeItem(at: url); continue }
      w.startSession(atSourceTime: .zero)
      writer = w; input = i
      return
    }
    log("can't start HE-AAC audio for \(url.path)")
  }

  /// A new run of audio (start, resume, a rebuilt device): times follow the meeting clock again
  func resync() { flushPending(); baseMs = nil }

  /// heardMs: when the device heard this buffer, on meeting time, if it says
  func append(_ buf: AVAudioPCMBuffer, heardMs: Double? = nil) {
    // the device stopped delivering for a while (setting up a new mic stalls the speakers' clock for a second or two):
    // the missing time becomes silence, so later audio stays on meeting time instead of sliding early.
    // Gaps between deliveries only: an output whose clock runs a little off (AirPlay) never trips it.
    if let heard = heardMs {
      if let last = lastHeardEnd, heard - last > 250 { resync() }
      lastHeardEnd = heard + Double(buf.frameLength) / buf.format.sampleRate * 1000
    }
    if buf.format.sampleRate != srcRate {
      srcRate = buf.format.sampleRate
      conv16 = AVAudioConverter(from: buf.format, to: mono16)
      conv48 = AVAudioConverter(from: buf.format, to: mono48)
    }
    if baseMs == nil {
      let ms = max(0, heardMs ?? (nowMs() - Double(buf.frameLength) / buf.format.sampleRate * 1000))
      baseMs = ms; sentSince = 0
      // file time is meeting time: startup, pauses and device rebuilds become silence, so both files line up with pcm ms
      padTo(Int64(ms * 48))
    }
    if let c = conv48, let b = convert(c, buf) { write(b) }
    if let c = conv16, let b = convert(c, buf), b.frameLength > 0 {
      onPcm16?(b, (baseMs ?? 0) + Double(sentSince + Int64(pending.count)) / 16)
      let p = b.floatChannelData![0]
      for i in 0..<Int(b.frameLength) { let x = p[i]; pending.append(x); sumSq += Double(x * x) }
      count += Int(b.frameLength)
      // 100 ms frames
      while pending.count >= 1600 { emit(1600) }
    }
  }

  func emit(_ n: Int) {
    guard n > 0, let base = baseMs else { return }
    let chunk = Array(pending.prefix(n))
    pending.removeFirst(n)
    let ms = (startOffsetMs + base + Double(sentSince) / 16).rounded()
    sentSince += Int64(n)
    if !stream { return }
    let payload = chunk.withUnsafeBufferPointer { Data(buffer: $0) }
    send(["t": "pcm", "track": name, "ms": Int(ms), "n": n], payload: payload)
  }
  func flushPending() { emit(pending.count) }

  /// Silence up to a point on the 48 kHz timeline
  func padTo(_ target: Int64) {
    while pts < target {
      let n = AVAudioFrameCount(min(Int64(4800), target - pts))
      guard let b = AVAudioPCMBuffer(pcmFormat: mono48, frameCapacity: n) else { return }
      b.frameLength = n
      memset(b.floatChannelData![0], 0, Int(n) * MemoryLayout<Float>.size)
      let before = pts
      write(b)
      if pts == before { return }
    }
  }

  func write(_ b: AVAudioPCMBuffer) {
    guard let input, let writer, writer.status == .writing, b.frameLength > 0 else { return }
    var sb: CMSampleBuffer?
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48000), presentationTimeStamp: CMTime(value: pts, timescale: 48000), decodeTimeStamp: .invalid)
    guard CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil,
                               formatDescription: b.format.formatDescription, sampleCount: CMItemCount(b.frameLength),
                               sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil,
                               sampleBufferOut: &sb) == noErr, let sb,
          CMSampleBufferSetDataBufferFromAudioBufferList(sb, blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
                                                         flags: 0, bufferList: b.audioBufferList) == noErr else { return }
    // a burst of padding can outpace the encoder for a moment; wait for it (up to 1 s) rather than lose time
    var tries = 0
    while !input.isReadyForMoreMediaData && tries < 200 { usleep(5000); tries += 1 }
    if input.isReadyForMoreMediaData && input.append(sb) { pts += Int64(b.frameLength) } else { log("\(name): writer busy, dropped \(b.frameLength) samples") }
  }

  /// 0..1 from -60 dB to 0 dB over what came in since the last call
  func level() -> Double {
    defer { sumSq = 0; count = 0 }
    guard count > 0 else { return 0 }
    let db = 20 * log10(sqrt(sumSq / Double(count)) + 1e-9)
    return min(1, max(0, (db + 60) / 60)).rounded(toPlaces: 3)
  }

  var writerCompleted: Bool { writer?.status == .completed }
  func cancel() { writer?.cancelWriting(); try? FileManager.default.removeItem(at: url) }

  func finish(_ group: DispatchGroup) {
    flushPending()
    guard let writer, let input else { return }
    if writer.status != .writing { return }
    if pts == 0 { writer.cancelWriting(); try? FileManager.default.removeItem(at: url); return }
    input.markAsFinished()
    group.enter()
    writer.finishWriting { if writer.status != .completed { log("\(self.name): \(writer.error?.localizedDescription ?? "not finished")") }; group.leave() }
  }
}

extension Double { func rounded(toPlaces p: Int) -> Double { let m = pow(10, Double(p)); return (self * m).rounded() / m } }

// MARK: Core Audio helpers

let system = AudioObjectID(kAudioObjectSystemObject)
func address(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}
func audioProcesses() -> [AudioObjectID] {
  var a = address(kAudioHardwarePropertyProcessObjectList)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &a, 0, nil, &size, &ids) == noErr else { return [] }
  return ids
}
func pidOf(_ obj: AudioObjectID) -> pid_t {
  var a = address(kAudioProcessPropertyPID), v: pid_t = 0, size = UInt32(MemoryLayout<pid_t>.size)
  _ = AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v)
  return v
}
func processObject(pid: pid_t) -> AudioObjectID? {
  var a = address(kAudioHardwarePropertyTranslatePIDToProcessObject)
  var p = pid, obj = AudioObjectID(kAudioObjectUnknown), size = UInt32(MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &a, UInt32(MemoryLayout<pid_t>.size), &p, &size, &obj) == noErr, obj != kAudioObjectUnknown else { return nil }
  return obj
}
func parentPid(_ pid: pid_t) -> pid_t {
  var info = kinfo_proc(), size = MemoryLayout<kinfo_proc>.size
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
  guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return 0 }
  return info.kp_eproc.e_ppid
}

/// Yogurt's own sound is left out: this helper, the app that started it, and the app's other helpers (Chromium plays sound from one)
func yogurtProcesses() -> [AudioObjectID] {
  let me = getpid(), app = getppid()
  var out = Set<AudioObjectID>()
  if let o = processObject(pid: me) { out.insert(o) }
  for obj in audioProcesses() {
    let pid = pidOf(obj)
    if pid == me || pid == app || parentPid(pid) == app { out.insert(obj) }
  }
  return Array(out)
}

func defaultOutputUID() -> String? {
  var a = address(kAudioHardwarePropertyDefaultOutputDevice), dev = AudioObjectID(0), size = UInt32(MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &a, 0, nil, &size, &dev) == noErr, dev != kAudioObjectUnknown else { return nil }
  var ua = address(kAudioDevicePropertyDeviceUID), uid: Unmanaged<CFString>?, us = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(dev, &ua, 0, nil, &us, &uid) == noErr, let uid else { return nil }
  return uid.takeRetainedValue() as String
}

func stringProp(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
  var a = address(sel), size = UInt32(MemoryLayout<CFString?>.size)
  var s: Unmanaged<CFString>?
  guard AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &s) == noErr, let v = s else { return nil }
  return v.takeRetainedValue() as String
}
func defaultInput() -> AudioObjectID? {
  var a = address(kAudioHardwarePropertyDefaultInputDevice), dev = AudioObjectID(0), size = UInt32(MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &a, 0, nil, &size, &dev) == noErr, dev != kAudioObjectUnknown else { return nil }
  return dev
}
/// The microphone with this UID, if it is on the Mac now and could be its input (the same test as yogurt-mac's list)
func micDevice(uid: String) -> AudioObjectID? {
  var a = address(kAudioHardwarePropertyTranslateUIDToDevice)
  var cf = uid as CFString
  var dev = AudioObjectID(kAudioObjectUnknown), size = UInt32(MemoryLayout<AudioObjectID>.size)
  let err = withUnsafePointer(to: &cf) { AudioObjectGetPropertyData(system, &a, UInt32(MemoryLayout<CFString>.size), $0, &size, &dev) }
  guard err == noErr, dev != kAudioObjectUnknown else { return nil }
  var sa = address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput), ss: UInt32 = 0
  var ca = address(kAudioDevicePropertyDeviceCanBeDefaultDevice, kAudioObjectPropertyScopeInput), can: UInt32 = 0, cs = UInt32(MemoryLayout<UInt32>.size)
  guard AudioObjectGetPropertyDataSize(dev, &sa, 0, nil, &ss) == noErr, ss > 0,
        AudioObjectGetPropertyData(dev, &ca, 0, nil, &cs, &can) == noErr, can != 0 else { return nil }
  return dev
}

/// The system's own answer for "System Audio Recording": 0 allowed, 1 denied, 2 not asked yet (or unknown)
func audioCapturePermission() -> Int {
  typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int
  guard let h = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW),
        let sym = dlsym(h, "TCCAccessPreflight") else { return 2 }
  return unsafeBitCast(sym, to: Preflight.self)("kTCCServiceAudioCapture" as CFString, nil)
}
func requestAudioCapture(_ done: @escaping (Bool) -> Void) {
  typealias Request = @convention(c) (CFString, CFDictionary?, @escaping @convention(block) (Bool) -> Void) -> Void
  guard let h = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW),
        let sym = dlsym(h, "TCCAccessRequest") else { return done(true) }
  unsafeBitCast(sym, to: Request.self)("kTCCServiceAudioCapture" as CFString, nil, done)
}

// MARK: the computer's sound

final class SystemAudio {
  var tap = AudioObjectID(kAudioObjectUnknown), agg = AudioObjectID(kAudioObjectUnknown)
  var proc: AudioDeviceIOProcID?
  let onBuffer: (AVAudioPCMBuffer, Double?) -> Void
  init(onBuffer: @escaping (AVAudioPCMBuffer, Double?) -> Void) { self.onBuffer = onBuffer }

  func start() -> Bool {
    let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: yogurtProcesses())
    desc.uuid = UUID()
    desc.name = "Lynote NoteTaker"
    desc.isPrivate = true
    desc.muteBehavior = .unmuted
    var err = AudioHardwareCreateProcessTap(desc, &tap)
    guard err == noErr else { log("tap failed: \(err)"); tap = AudioObjectID(kAudioObjectUnknown); return false }

    var fa = address(kAudioTapPropertyFormat), asbd = AudioStreamBasicDescription(), size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    err = AudioObjectGetPropertyData(tap, &fa, 0, nil, &size, &asbd)
    guard err == noErr, let format = AVAudioFormat(streamDescription: &asbd) else { log("tap format failed: \(err)"); stop(); return false }

    // a private device around the tap, clocked by the speakers: nothing shows up in Sound settings and other apps don't see it.
    // A device with only the tap in it never runs, and with tap auto-start it only runs while something plays.
    guard let outUID = defaultOutputUID() else { log("no output device"); stop(); return false }
    let dict: [String: Any] = [
      kAudioAggregateDeviceNameKey: "Lynote NoteTaker", kAudioAggregateDeviceUIDKey: UUID().uuidString,
      kAudioAggregateDeviceMainSubDeviceKey: outUID, kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outUID]],
      kAudioAggregateDeviceIsPrivateKey: true, kAudioAggregateDeviceIsStackedKey: false, kAudioAggregateDeviceTapAutoStartKey: false,
      kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: desc.uuid.uuidString, kAudioSubTapDriftCompensationKey: true]],
    ]
    err = AudioHardwareCreateAggregateDevice(dict as CFDictionary, &agg)
    guard err == noErr else { log("aggregate device failed: \(err)"); agg = AudioObjectID(kAudioObjectUnknown); stop(); return false }

    let onBuffer = self.onBuffer
    err = AudioDeviceCreateIOProcIDWithBlock(&proc, agg, nil) { _, inData, inTime, _, _ in
      // the tap's stream comes after any inputs the output device has; it is interleaved stereo, so one buffer holds it
      let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inData))
      guard format.isInterleaved || format.channelCount == 1, let tapBuf = list.last(where: { $0.mNumberChannels == format.channelCount }) else { return }
      var one = AudioBufferList(mNumberBuffers: 1, mBuffers: tapBuf)
      // mono() copies: the system reuses this memory as soon as we return
      guard let b = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: &one, deallocator: nil), let m = mono(b, firstOnly: false) else { return }
      let heard: Double? = inTime.pointee.mFlags.contains(.hostTimeValid) ? hostMs(inTime.pointee.mHostTime) : nil
      work.async { onBuffer(m, heard) }
    }
    guard err == noErr else { log("io proc failed: \(err)"); stop(); return false }
    err = AudioDeviceStart(agg, proc)
    guard err == noErr else { log("start failed: \(err)"); stop(); return false }
    return true
  }

  func stop() {
    if agg != kAudioObjectUnknown {
      if let proc { AudioDeviceStop(agg, proc); AudioDeviceDestroyIOProcID(agg, proc) }
      AudioHardwareDestroyAggregateDevice(agg)
    }
    if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap) }
    proc = nil; agg = AudioObjectID(kAudioObjectUnknown); tap = AudioObjectID(kAudioObjectUnknown)
  }
}

// MARK: the microphone

final class Mic {
  var engine: AVAudioEngine?
  /// the microphone to record from; nil: the Mac's default input
  var device: AudioObjectID?
  let onBuffer: (AVAudioPCMBuffer) -> Void
  init(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) { self.onBuffer = onBuffer }

  func start() -> Bool {
    let e = AVAudioEngine()
    let input = e.inputNode
    // No voice processing: with it on, the call app on the same mic (Zoom) got near silence until Yogurt stopped.
    // The call coming out of the speakers is caught after the fact instead (echoDetect.ts, echo.ts).
    if let d = device, !choose(d, on: input) { device = nil }
    guard tap(e) else { return false }
    e.prepare()
    do { try e.start() } catch { log("microphone failed: \(error.localizedDescription)"); input.removeTap(onBus: 0); return false }
    engine = e
    return true
  }

  /// Records from this device instead of the default. CurrentDevice is a global property of the input unit.
  private func choose(_ dev: AudioObjectID, on input: AVAudioInputNode) -> Bool {
    guard let au = input.audioUnit else { log("no microphone unit"); return false }
    var d = dev
    let err = AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &d, UInt32(MemoryLayout<AudioObjectID>.size))
    if err != noErr { log("couldn't choose the microphone: \(err)") }
    return err == noErr
  }

  /// the tap, in the input's format now (a new output device can change its rate)
  private func tap(_ e: AVAudioEngine) -> Bool {
    let input = e.inputNode
    let fmt = input.outputFormat(forBus: 0)
    guard fmt.sampleRate > 0, fmt.channelCount > 0 else { log("no microphone"); return false }
    let onBuffer = self.onBuffer
    input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(fmt.sampleRate / 10), format: fmt) { b, _ in
      guard let m = mono(b, firstOnly: true) else { return }
      work.async { onBuffer(m) }
    }
    return true
  }

  /// The engine stopped for a configuration change (a device or format moved): start the same engine again,
  /// which takes milliseconds; building a new one loses more of the mic.
  func restart() -> Bool {
    guard let e = engine else { return false }
    if e.isRunning { return true }
    e.inputNode.removeTap(onBus: 0)
    guard tap(e) else { return false }
    e.prepare()
    do { try e.start() } catch { log("microphone restart failed: \(error.localizedDescription)"); return false }
    return true
  }

  /// The same engine on another mic: much less silence than a rebuild
  func move(to dev: AudioObjectID) -> Bool {
    guard let e = engine else { return false }
    e.stop()
    e.inputNode.removeTap(onBus: 0)
    guard choose(dev, on: e.inputNode), tap(e) else { return false }
    e.prepare()
    do { try e.start() } catch { log("microphone move failed: \(error.localizedDescription)"); return false }
    device = dev
    return true
  }

  func stop() {
    guard let e = engine else { return }
    e.inputNode.removeTap(onBus: 0)
    e.stop()
    engine = nil
  }
}

// MARK: Apple speech (macOS 26): live words on the Neural Engine, on this Mac only

/// Where each buffer goes on the analyzer's timeline, in samples. The analyzer stops for good on a buffer that starts
/// before the last one ended, and meeting times in whole ms did that within a second (a 48 kHz tap gives 16 kHz buffers
/// of 170.67 samples). So buffers follow on back to back, and only a real jump ahead (a pause, a rebuilt device) moves on.
struct SpeechClock {
  let rate: Double
  var next: Int64? = nil
  init(rate: Double) { self.rate = rate }
  mutating func place(atMs ms: Double, frames: Int) -> Int64 {
    var at = Int64((ms * rate / 1000).rounded())
    // within 50 ms ahead (rounding, a resampler's slack) or anywhere behind: right after the last one
    if let n = next, at < n + Int64(rate / 20) { at = n }
    next = at + Int64(frames)
    return at
  }
}

// Older developer tools can build capture and Whisper without the optional macOS 26 speech APIs.
#if compiler(>=6.2)
/// Never SFSpeechRecognizer (it may send audio away): SpeechAnalyzer and SpeechTranscriber run on the Mac. One per track,
/// fed the same 16 kHz audio as the pcm stream, on meeting time, so its words line up with whisper's.
/// If it stops anyway it starts again (a few times), so the live words never stay with whisper's slower ones.
@available(macOS 26, *)
final class LiveSpeech {
  let track: String
  let locale: Locale
  // feed comes from the audio queue, a restart from the results task
  let lock = NSLock()
  var analyzer: SpeechAnalyzer?
  var input: AsyncStream<AnalyzerInput>.Continuation?
  var format: AVAudioFormat?
  var conv: AVAudioConverter?
  var clock = SpeechClock(rate: 16000)
  var task: Task<Void, Never>?
  var started = false, finishing = false
  var restarts = 0
  static let maxRestarts = 5

  init(track: String, locale: Locale) { self.track = track; self.locale = locale }

  func start() async -> Bool {
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [.audioTimeRange])
    let an = SpeechAnalyzer(modules: [transcriber])
    guard let f = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { log("speech: no audio format"); return false }
    let (stream, cont) = AsyncStream<AnalyzerInput>.makeStream()
    let name = track
    let t = Task { [weak self] in
      do {
        for try await r in transcriber.results {
          let text = String(r.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
          if text.isEmpty { continue }
          let s = CMTimeGetSeconds(r.range.start) * 1000, e = CMTimeGetSeconds(CMTimeRangeGetEnd(r.range)) * 1000
          // each run's time: a final has a run a word, so a whisper line can take exactly its own words off the live view
          var words: [[String: Any]] = []
          for run in r.text.runs {
            guard let tr = run.audioTimeRange else { continue }
            words.append(["text": String(r.text[run.range].characters), "startMs": (CMTimeGetSeconds(tr.start) * 1000).rounded(), "endMs": (CMTimeGetSeconds(CMTimeRangeGetEnd(tr)) * 1000).rounded()])
          }
          send(["t": "speech", "track": name, "final": r.isFinal, "startMs": s.rounded(), "endMs": e.rounded(), "text": text, "words": words])
        }
      } catch {
        log("speech \(name) stopped: \(error.localizedDescription)")
        await self?.again()
      }
    }
    do { try await an.start(inputSequence: stream) } catch { log("speech \(track) failed to start: \(error.localizedDescription)"); t.cancel(); return false }
    lock.withLock {
      analyzer = an; input = cont; format = f; task = t
      conv = AVAudioConverter(from: mono16, to: f)
      clock = SpeechClock(rate: f.sampleRate)
      started = true
    }
    return true
  }

  /// A new analyzer after one stopped; the audio meanwhile is skipped, the meeting time carries on
  func again() async {
    let go: Bool = lock.withLock {
      if finishing || restarts >= LiveSpeech.maxRestarts { return false }
      restarts += 1; started = false; input?.finish(); input = nil
      return true
    }
    guard go else { log("speech \(track): not starting again"); return }
    if await start() { log("speech \(track) started again (\(restarts) of \(LiveSpeech.maxRestarts))") }
  }

  /// a 16 kHz mono buffer that begins at meeting time ms
  func feed(_ b: AVAudioPCMBuffer, atMs ms: Double) {
    lock.withLock {
      guard started, let f = format else { return }
      var out: AVAudioPCMBuffer? = b
      if f.sampleRate != mono16.sampleRate || f.commonFormat != mono16.commonFormat || f.channelCount != 1 { guard let c = conv else { return }; out = convert(c, b) }
      guard let o = out, o.frameLength > 0 else { return }
      let at = clock.place(atMs: ms, frames: Int(o.frameLength))
      input?.yield(AnalyzerInput(buffer: o, bufferStartTime: CMTime(value: at, timescale: CMTimeScale(f.sampleRate))))
    }
  }

  /// Local measurement only: a buffer at time zero, which the analyzer refuses as it refused the old whole-ms times
  func testOverlap(_ b: AVAudioPCMBuffer) {
    lock.withLock {
      guard started, let c = conv, let o = convert(c, b), o.frameLength > 0 else { return }
      input?.yield(AnalyzerInput(buffer: o, bufferStartTime: .zero))
    }
  }

  func finish() async {
    let (i, an, t): (AsyncStream<AnalyzerInput>.Continuation?, SpeechAnalyzer?, Task<Void, Never>?) = lock.withLock {
      finishing = true
      return (input, analyzer, task)
    }
    i?.finish()
    try? await an?.finalizeAndFinishThroughEndOfInput()
    t?.cancel()
  }
}

/// The locale Apple lists for this one (the exact tag, else the same language and region, else the same language)
@available(macOS 26, *)
func speechLocale(_ wanted: String, in list: [Locale]) -> Locale? {
  let w = Locale(identifier: wanted)
  let ordered = list.sorted { $0.identifier(.bcp47) < $1.identifier(.bcp47) }
  if let exact = ordered.first(where: { $0.identifier(.bcp47).lowercased() == w.identifier(.bcp47).lowercased() }) { return exact }
  guard let language = w.language.languageCode?.identifier else { return nil }
  if let region = w.language.region?.identifier, let r = ordered.first(where: { $0.language.languageCode?.identifier == language && $0.language.region?.identifier == region }) { return r }
  return ordered.first { $0.language.languageCode?.identifier == language }
}

#endif

// MARK: recorder

let testing = ProcessInfo.processInfo.environment["YOGURT_AUDIO_TEST"] == "1"

final class Recorder {
  let me: Track, them: Track
  var mic: Mic!, sys: SystemAudio!
  var paused = false, finishing = false, sysAllowed = true
  var timer: DispatchSourceTimer?
  var micRebuild: DispatchWorkItem?, sysRebuild: DispatchWorkItem?
  /// the microphone the person chose (its UID); nil is Auto, the Mac's default input, followed as it changes
  var micUID: String? = argValue("--mic")
  /// Apple's live speech per track (macOS 26, when asked for with --speech), as Any so older Macs never see the type
  var speech: [String: Any] = [:]

  init(dir: URL) {
    me = Track("me", dir: dir); them = Track("them", dir: dir)
    mic = Mic { [unowned self] b in if !self.paused && !self.finishing { self.me.append(b) } }
    sys = SystemAudio { [unowned self] b, heard in if !self.paused && !self.finishing { self.them.append(b, heardMs: heard) } }
  }

  /// Apple's speech on both tracks, in the locale asked for; words come out as speech frames beside the pcm
  func startSpeech(_ wanted: String) {
    #if compiler(>=6.2)
    guard #available(macOS 26, *) else { log("speech: needs macOS 26"); send(["t": "speech-off"]); return }
    Task {
      guard let locale = speechLocale(wanted, in: await SpeechTranscriber.installedLocales) else { log("speech: \(wanted) is not installed"); send(["t": "speech-off"]); return }
      var started = 0
      for track in [me, them] {
        let live = LiveSpeech(track: track.name, locale: locale)
        guard await live.start() else { continue }
        started += 1
        work.async { [unowned self] in
          self.speech[track.name] = live
          track.onPcm16 = { b, ms in live.feed(b, atMs: ms) }
        }
      }
      // one track without it is better than none; none at all means whisper's own readings take over
      if started == 0 { send(["t": "speech-off"]) } else {
        log("speech: listening in \(locale.identifier(.bcp47))")
        work.async { [unowned self] in send(["t": "speech-ready", "tracks": Array(self.speech.keys).sorted()]) }
      }
    }
    #else
    log("speech: this build uses Whisper for live words")
    send(["t": "speech-off"])
    #endif
  }

  func start() {
    me.openWriter(); them.openWriter()
    if let wanted = argValue("--speech") { startSpeech(wanted) }
    // a remembered mic that isn't here today: Auto, quietly (nothing was lost mid-meeting)
    if let uid = micUID, micDevice(uid: uid) == nil { log("the chosen microphone isn't here: using the Mac's"); micUID = nil }
    mic.device = micUID.flatMap(micDevice)
    if !mic.start() { log("recording without the microphone") }
    if mic.device == nil { micUID = nil }
    reportMic()
    startSystem()

    let t = DispatchSource.makeTimerSource(queue: work)
    t.schedule(deadline: .now() + 0.1, repeating: 0.1)
    t.setEventHandler { [unowned self] in
      if self.finishing { return }
      send(["t": "level", "me": self.paused ? 0 : self.me.level(), "them": self.paused ? 0 : self.them.level()])
    }
    t.resume(); timer = t

    listen(kAudioHardwarePropertyDefaultOutputDevice) { [unowned self] in self.rebuildSystem() }
    // Auto follows the Mac's input; a chosen mic stays put
    listen(kAudioHardwarePropertyDefaultInputDevice) { [unowned self] in if self.micUID == nil { self.rebuildMic() } }
    // a chosen mic unplugged: back to Auto
    listen(kAudioHardwarePropertyDevices) { [unowned self] in if let uid = self.micUID, micDevice(uid: uid) == nil { self.rebuildMic() } }
    NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil) { [weak self] n in
      guard let self, (n.object as? AVAudioEngine) === self.mic.engine else { return }
      work.async { self.restartMic() }
    }
  }

  func startSystem() {
    switch audioCapturePermission() {
    case 1: sysAllowed = false
    case 0: break
    default:
      // first time: the system asks; the mic keeps recording meanwhile
      requestAudioCapture { ok in work.async {
        if !ok { self.sysAllowed = false; send(["t": "warn", "code": "no-system-audio"]); return }
        if !self.finishing && !self.sys.start() { send(["t": "warn", "code": "no-system-audio"]) }
      } }
      return
    }
    if !sysAllowed || !sys.start() { send(["t": "warn", "code": "no-system-audio"]) }
  }

  func listen(_ sel: AudioObjectPropertySelector, _ fn: @escaping () -> Void) {
    var a = address(sel)
    AudioObjectAddPropertyListenerBlock(system, &a, work) { _, _ in fn() }
  }

  // device changes come in bursts; rebuild once they settle, without stopping the recording
  func rebuildSystem() {
    sysRebuild?.cancel()
    let item = DispatchWorkItem { [unowned self] in
      guard !self.finishing, self.sysAllowed else { return }
      self.sys.stop(); self.them.resync()
      if !self.sys.start() { send(["t": "warn", "code": "no-system-audio"]) }
      send(["t": "warn", "code": "device-changed"])
    }
    sysRebuild = item
    work.asyncAfter(deadline: .now() + 0.3, execute: item)
  }
  /// The output changed and took the mic's engine with it: started again at once, rebuilt only if that fails
  func restartMic() {
    guard !finishing else { return }
    me.resync()
    // the chosen mic was unplugged: never start the old engine on it again
    if let uid = micUID, micDevice(uid: uid) == nil { rebuildMic(); return }
    if mic.restart() { send(["t": "warn", "code": "device-changed"]); reportMic(); return }
    log("restarting the microphone failed: building it again")
    rebuildMic()
  }
  /// A new engine on the chosen mic (or the default). The time in between is silence in me.m4a, so it stays on meeting time.
  func rebuildMic(after delay: Double = 0.3) {
    micRebuild?.cancel()
    let item = DispatchWorkItem { [unowned self] in
      guard !self.finishing else { return }
      if let uid = self.micUID, micDevice(uid: uid) == nil {
        log("the chosen microphone went away: using the Mac's")
        self.micUID = nil
        send(["t": "warn", "code": "mic-gone"])
      }
      self.mic.stop(); self.me.resync()
      self.mic.device = self.micUID.flatMap(micDevice)
      if !self.mic.start() { log("microphone lost") }
      // the chosen mic can't be recorded from: Auto, and the picker is told
      if self.micUID != nil && self.mic.device == nil { self.micUID = nil; send(["t": "warn", "code": "mic-gone"]) }
      send(["t": "warn", "code": "device-changed"])
      self.reportMic()
    }
    micRebuild = item
    work.asyncAfter(deadline: .now() + delay, execute: item)
  }
  /// Which mic records now, for the picker: the chosen one, or Auto with the default's name
  func reportMic() {
    let dev = mic.device ?? defaultInput()
    send(["t": "mic", "uid": micUID as Any? ?? NSNull(), "name": dev.flatMap { stringProp($0, kAudioObjectPropertyName) } as Any? ?? NSNull()])
  }
  /// mic UID, or mic auto: switch now, without stopping the recording. An unknown mic changes nothing.
  func chooseMic(_ arg: String) {
    let uid: String? = arg == "auto" ? nil : arg
    if let uid, micDevice(uid: uid) == nil { log("no microphone \(uid) here"); reportMic(); return }
    if uid == micUID && mic.engine != nil { reportMic(); return }
    micUID = uid
    me.resync()
    if let dev = uid.flatMap(micDevice) ?? defaultInput(), mic.move(to: dev) {
      if uid == nil { mic.device = nil }
      send(["t": "warn", "code": "device-changed"]); reportMic(); return
    }
    log("moving the microphone failed: building it again")
    rebuildMic(after: 0)
  }

  func command(_ c: String) {
    switch c {
    case "pause": paused = true; me.flushPending(); them.flushPending()
    case "resume": paused = false; me.resync(); them.resync()
    case "stop": finish()
    case _ where c.hasPrefix("mic "): chooseMic(String(c.dropFirst(4)).trimmingCharacters(in: .whitespaces))
    // local measurements only (YOGURT_AUDIO_TEST=1): the engine stopped as a configuration change stops it, then
    // brought back the way an output switch now does (restart) or used to (rebuild)
    case "test-mic-restart" where testing: work.async { self.mic.engine?.stop(); self.restartMic() }
    case "test-mic-rebuild" where testing: work.async { self.mic.engine?.stop(); self.rebuildMic() }
    default: log("unknown command: \(c)")
    }
  }

  func finish() {
    if finishing { return }
    finishing = true
    timer?.cancel()
    mic.stop(); sys.stop()
    me.flushPending(); them.flushPending()
    // both files end together, so they stay the same length
    let end = max(me.pts, them.pts)
    me.padTo(end); them.padTo(end)
    let g = DispatchGroup()
    me.finish(g); them.finish(g)
    // Apple's last words, but never holding the exit for more than a few seconds
    #if compiler(>=6.2)
    if #available(macOS 26, *), !speech.isEmpty {
      g.enter()
      let lives = speech.values.compactMap { $0 as? LiveSpeech }
      var left = false
      let leave = { if !left { left = true; g.leave() } }
      Task { for l in lives { await l.finish() }; work.async { leave() } }
      work.asyncAfter(deadline: .now() + 4) { leave() }
    }
    #endif
    g.notify(queue: .global()) { outQ.async { exit(0) } }
  }
}

// MARK: join

/// Parts of one track, in order: (part number, file, meeting time its file starts at)
func partsOf(_ name: String, in dir: URL) -> [(Int, URL, Double)] {
  let fm = FileManager.default
  var out: [(Int, URL, Double)] = []
  let main = dir.appendingPathComponent("\(name).m4a")
  if fm.fileExists(atPath: main.path) { out.append((0, main, 0)) }
  for f in (try? fm.contentsOfDirectory(atPath: dir.path)) ?? [] {
    let c = f.split(separator: ".").map(String.init)
    guard c.count == 3, c[0] == name, c[2] == "m4a", let n = Int(c[1]), n > 0 else { continue }
    var start = Double.nan
    if let d = try? Data(contentsOf: dir.appendingPathComponent("part.\(n).json")),
       let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let ms = j["startMs"] as? Double { start = ms }
    out.append((n, dir.appendingPathComponent(f), start))
  }
  return out.sorted { $0.0 < $1.0 }
}

/// One file per track on meeting time. Exit code 0 when everything that had parts was joined.
func retainAudio(_ url: URL, in dir: URL) throws {
  let originals = dir.appendingPathComponent("original", isDirectory: true)
  try FileManager.default.createDirectory(at: originals, withIntermediateDirectories: true)
  try FileManager.default.linkItem(at: url, to: originals.appendingPathComponent("\(UUID().uuidString)-\(url.lastPathComponent)"))
}

func joinParts(_ dir: URL) -> Int32 {
  let fm = FileManager.default
  var failed = false
  var joinedParts = Set<Int>()
  for name in ["me", "them"] {
    let parts = partsOf(name, in: dir)
    if !parts.contains(where: { $0.0 > 0 }) { continue }
    guard parts.allSatisfy({ $0.2.isFinite && $0.2 >= 0 }) else { log("join: missing or invalid part timeline"); failed = true; continue }
    // a join that died after replacing the main file but before removing the parts: the main file already covers every
    // part, so appending them again would repeat audio. Just clean up.
    if let first = parts.first, first.0 == 0 {
      let mainEnd = CMTimeGetSeconds(AVURLAsset(url: first.1).duration)
      let covered = parts.dropFirst().allSatisfy { p in
        let d = CMTimeGetSeconds(AVURLAsset(url: p.1).duration)
        return d.isFinite && p.2 / 1000 < mainEnd - 0.001 && p.2 / 1000 + d <= mainEnd + 0.1
      }
      if mainEnd.isFinite && covered {
        do {
          // An older version may have crashed after the swap without retaining the original parts.
          for (_, url, _) in parts where url != first.1 { try retainAudio(url, in: dir) }
          for (n, url, _) in parts where n > 0 { try fm.removeItem(at: url); joinedParts.insert(n) }
        } catch { log("join: couldn't retain recovered parts: \(error.localizedDescription)"); failed = true }
        continue
      }
    }
    // decode each part and write it into one new file, padding with silence up to where the part starts:
    // an export's empty gaps are not reliably kept, writing the silence out is
    let tmp = dir.appendingPathComponent("\(name).joined.m4a")
    try? fm.removeItem(at: tmp)
    let out = Track(name, file: tmp)
    out.openWriter()
    var used = 0, unreadable = false
    for (n, url, startMs) in parts {
      let asset = AVURLAsset(url: url)
      guard let src = asset.tracks(withMediaType: .audio).first, let reader = try? AVAssetReader(asset: asset) else { log("join: unreadable \(url.lastPathComponent); keeping all parts"); unreadable = true; break }
      let o = AVAssetReaderTrackOutput(track: src, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false, AVLinearPCMIsBigEndianKey: false,
      ])
      guard reader.canAdd(o) else { unreadable = true; break }
      reader.add(o)
      guard reader.startReading() else { log("join: can't read \(url.lastPathComponent): \(reader.error?.localizedDescription ?? "")"); unreadable = true; break }
      let target = Int64(startMs * 48)
      out.padTo(target)
      if out.pts < target { unreadable = true; break }
      while let sb = o.copyNextSampleBuffer() {
        let frames = CMSampleBufferGetNumSamples(sb)
        guard frames > 0, let b = AVAudioPCMBuffer(pcmFormat: mono48, frameCapacity: AVAudioFrameCount(frames)) else { unreadable = true; break }
        b.frameLength = AVAudioFrameCount(frames)
        if CMSampleBufferCopyPCMDataIntoAudioBufferList(sb, at: 0, frameCount: Int32(frames), into: b.mutableAudioBufferList) != noErr { log("join: bad audio in part \(n)"); unreadable = true; break }
        let before = out.pts
        out.write(b)
        if out.pts - before != Int64(frames) { unreadable = true; break }
      }
      if unreadable || reader.status != .completed { unreadable = true; break }
      used += 1
    }
    if unreadable { failed = true; out.cancel(); try? fm.removeItem(at: tmp); continue }
    if used == 0 { log("join: nothing readable for \(name)"); failed = true; out.cancel(); continue }
    let g = DispatchGroup()
    out.finish(g)
    g.wait()
    guard out.writerCompleted, let decodedMs = decodedAudio(tmp), abs(decodedMs - Double(out.pts) / 48) <= 1000 else { log("join: could not write the joined file for \(name)"); failed = true; try? fm.removeItem(at: tmp); continue }
    let main = dir.appendingPathComponent("\(name).m4a")
    do {
      // Joining re-encodes both legacy and new HE sessions: retain every exact input before replacing anything.
      for (_, url, _) in parts { try retainAudio(url, in: dir) }
      if fm.fileExists(atPath: main.path) { _ = try fm.replaceItemAt(main, withItemAt: tmp) } else { try fm.moveItem(at: tmp, to: main) }
    } catch { log("join: can't write \(main.path): \(error.localizedDescription)"); failed = true; continue }
    // part.N.json is shared by both tracks, so it goes after the last one
    for (n, url, _) in parts where n > 0 { try? fm.removeItem(at: url); joinedParts.insert(n) }
  }
  if !failed { for n in joinedParts { try? fm.removeItem(at: dir.appendingPathComponent("part.\(n).json")) } }
  return failed ? 1 : 0
}

/// Read-only append offset. Existing parts must be joined successfully before another session starts.
func inspectAudio(_ dir: URL) {
  let fm = FileManager.default
  var duration = 0.0
  var tracks: [String: [String: Any]] = [:]
  for name in ["me", "them"] {
    let parts = partsOf(name, in: dir)
    guard !parts.contains(where: { $0.0 > 0 }) else { fail("inspect: recording still has unjoined parts") }
    for (_, url, _) in parts {
      let asset = AVURLAsset(url: url)
      let seconds = CMTimeGetSeconds(asset.duration)
      guard seconds.isFinite && seconds >= 0 && !asset.tracks(withMediaType: .audio).isEmpty else { fail("inspect: unreadable \(url.lastPathComponent)") }
      duration = max(duration, seconds * 1000)
      if let track = asset.tracks(withMediaType: .audio).first,
         let description = track.formatDescriptions.first,
         let format = playbackAudioFormat(description as! CMAudioFormatDescription) {
        tracks[name] = ["formatID": format.mFormatID, "sampleRate": format.mSampleRate,
                        "channels": format.mChannelsPerFrame, "bitsPerSecond": track.estimatedDataRate,
                        "durationMs": seconds * 1000]
      }
    }
  }
  guard !((try? fm.contentsOfDirectory(atPath: dir.path)) ?? []).contains(where: { $0.hasPrefix("part.") && $0.hasSuffix(".json") }) else { fail("inspect: recording still has part metadata") }
  let data = try! JSONSerialization.data(withJSONObject: ["durationMs": Int(ceil(duration)), "tracks": tracks])
  _ = writeAll(data + Data([10]))
}

/// HE-AAC can expose its AAC-LC core as the basic ASBD. Resolve its cookie-backed format list instead.
/// Core Media chooses the richest profile this Mac can decode (including HE's SBR sample rate).
func playbackAudioFormat(_ description: CMAudioFormatDescription) -> AudioStreamBasicDescription? {
  if let format = CMAudioFormatDescriptionGetRichestDecodableFormat(description) { return format.pointee.mASBD }
  return CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee
}

/// Only a known HE-AAC 16 kb/s track can skip migration; all other formats are decoded normally.
func isCompactAudio(_ url: URL) -> Bool {
  guard let track = AVURLAsset(url: url).tracks(withMediaType: .audio).first,
        let description = track.formatDescriptions.first,
        let format = playbackAudioFormat(description as! CMAudioFormatDescription) else { return false }
  return format.mFormatID == kAudioFormatMPEG4AAC_HE && track.estimatedDataRate > 0 && track.estimatedDataRate <= 20000
}

/// Decoding measures audible samples, not just a container header, and handles legacy AAC and HE-AAC alike.
func decodedAudio(_ url: URL, into out: Track? = nil) -> Double? {
  let asset = AVURLAsset(url: url)
  guard let track = asset.tracks(withMediaType: .audio).first, let reader = try? AVAssetReader(asset: asset) else { return nil }
  let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false,
  ])
  guard reader.canAdd(output) else { return nil }
  reader.add(output)
  guard reader.startReading() else { return nil }
  var total: Int64 = 0
  while let sample = output.copyNextSampleBuffer() {
    let frames = CMSampleBufferGetNumSamples(sample)
    guard frames > 0 else { continue }
    if let out {
      guard let buffer = AVAudioPCMBuffer(pcmFormat: mono48, frameCapacity: AVAudioFrameCount(frames)) else { return nil }
      buffer.frameLength = AVAudioFrameCount(frames)
      guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(frames), into: buffer.mutableAudioBufferList) == noErr else { return nil }
      let before = out.pts
      out.write(buffer)
      guard out.pts - before == Int64(frames) else { return nil }
    }
    total += Int64(frames)
  }
  return reader.status == .completed ? Double(total) / 48 : nil
}

/// Writes only the caller's staging directory. Main validates both results before preserving and replacing files.
func compactAudio(_ dir: URL, into destination: URL) {
  guard dir.resolvingSymlinksInPath() != destination.resolvingSymlinksInPath() else { fail("compact: separate output directory required") }
  let tracks = ["me", "them"]
  if tracks.allSatisfy({ isCompactAudio(dir.appendingPathComponent("\($0).m4a")) }) { print("null"); return }
  var result: [String: [String: Double]] = [:]
  for name in tracks {
    let source = dir.appendingPathComponent("\(name).m4a"), target = destination.appendingPathComponent("\(name).m4a")
    let out = Track(name, file: target)
    out.openWriter()
    guard out.writer != nil, let sourceMs = decodedAudio(source, into: out), sourceMs > 0 else { out.cancel(); fail("compact: source could not be decoded") }
    let done = DispatchGroup(); out.finish(done); done.wait()
    guard out.writerCompleted, let outputMs = decodedAudio(target), abs(outputMs - sourceMs) <= 1000 else { fail("compact: decoded duration mismatch") }
    result[name] = ["sourceMs": sourceMs, "outputMs": outputMs]
  }
  let data = try! JSONSerialization.data(withJSONObject: result)
  _ = writeAll(data + Data([10]))
}

// MARK: main

func argValue(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}
// CI-only writer probe: feed committed audio through the real recording Track in paced 100 ms chunks.
// It opens no devices and waits before finishWriting, so a test can inspect/kill a genuinely unfinished file.
if args.count >= 2, args[1] == "writer-probe" {
  guard testing, let output = argValue("--dir"), let mic = argValue("--me"), let call = argValue("--them") else { fail("writer-probe requires YOGURT_AUDIO_TEST=1 and fixture paths") }
  let dir = URL(fileURLWithPath: output)
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  var sources: [(AVAudioFile, Track)] = []
  for (name, path) in [("me", mic), ("them", call)] {
    let target = dir.appendingPathComponent("\(name).m4a")
    guard !FileManager.default.fileExists(atPath: target.path),
          let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)),
          file.processingFormat.sampleRate > 0, Double(file.length) / file.processingFormat.sampleRate <= 60 else { fail("writer-probe requires new output and a short readable fixture") }
    let track = Track(name, file: target); track.stream = false; track.openWriter()
    guard track.writer != nil else { fail("writer-probe could not open writer") }
    sources.append((file, track))
  }
  while sources.contains(where: { $0.0.framePosition < $0.0.length }) {
    for (file, track) in sources where file.framePosition < file.length {
      let at = file.framePosition
      let count = AVAudioFrameCount(min(file.length - at, AVAudioFramePosition(file.processingFormat.sampleRate / 10)))
      guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: count), (try? file.read(into: buffer, frameCount: count)) != nil else { fail("writer-probe fixture read failed") }
      track.append(buffer, heardMs: Double(at) / file.processingFormat.sampleRate * 1000)
      guard track.writer?.status == .writing else { fail("writer-probe writer stopped") }
    }
    usleep(100_000)
  }
  send(["t": "writer-fed", "inputMs": sources.map { Double($0.0.length) / $0.0.processingFormat.sampleRate * 1000 }.max() ?? 0,
        "fragmentMs": CMTimeGetSeconds(sources[0].1.writer!.movieFragmentInterval) * 1000])
  // Only an explicit finish finalizes. EOF/kill preserves the same unfinished bytes as a recorder crash.
  if readLine() == "finish" {
    let done = DispatchGroup(); for (_, track) in sources { track.finish(done) }; done.wait()
  }
  exit(0)
}
// Tests: where buffers go on Apple speech's timeline, "ms frames" lines in, one start sample per line out
if args.count >= 3, args[1] == "speech-clock", let rate = Double(args[2]) {
  var c = SpeechClock(rate: rate)
  while let line = readLine() {
    let p = line.split(separator: " ")
    guard p.count == 2, let ms = Double(p[0]), let n = Int(p[1]) else { continue }
    print(c.place(atMs: ms, frames: n))
  }
  exit(0)
}
// Local measurement only: a 16 kHz mono wav through Apple's speech in LOCALE, final lines as speech frames on stdout
if args.count >= 4, args[1] == "speech-file" {
  #if compiler(>=6.2)
  guard #available(macOS 26, *) else { fail("speech-file needs macOS 26") }
  let locale = args[2], file = URL(fileURLWithPath: args[3])
  let done = DispatchSemaphore(value: 0)
  Task {
    guard let loc = speechLocale(locale, in: await SpeechTranscriber.installedLocales) else { fail("\(locale) is not installed") }
    let live = LiveSpeech(track: "them", locale: loc)
    guard await live.start() else { fail("speech did not start") }
    guard let f = try? AVAudioFile(forReading: file) else { fail("can't read \(file.path)") }
    // --live: the way a recording feeds it, through a track in small 48 kHz buffers like the system's (times with fractions of a ms)
    if args.contains("--live") {
      let t = Track("them", file: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("speech-file-live.m4a"))
      t.stream = false
      t.onPcm16 = { b, ms in live.feed(b, atMs: ms) }
      guard let all = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(f.length)), (try? f.read(into: all)) != nil,
            let to48 = AVAudioConverter(from: all.format, to: mono48), let a48 = convert(to48, all) else { fail("can't read \(file.path)") }
      let n = Int(a48.frameLength), src = a48.floatChannelData![0]
      var i = 0
      while i < n {
        let k = min(512, n - i)
        guard let b = AVAudioPCMBuffer(pcmFormat: mono48, frameCapacity: AVAudioFrameCount(k)) else { break }
        b.frameLength = AVAudioFrameCount(k)
        memcpy(b.floatChannelData![0], src + i, k * MemoryLayout<Float>.size)
        t.append(b)
        i += k
        // --break: one refused buffer 20 s in, to see the analyzer start again
        if args.contains("--break"), i - k < 48000 * 20, i >= 48000 * 20, let z = AVAudioPCMBuffer(pcmFormat: mono16, frameCapacity: 1600) {
          z.frameLength = 1600; memset(z.floatChannelData![0], 0, 1600 * MemoryLayout<Float>.size)
          live.testOverlap(z)
          // let the stop arrive and the new analyzer start before more audio
          try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
      }
      await live.finish()
      done.signal()
      return
    }
    let frames = AVAudioFrameCount(16000)
    var ms = 0.0
    while let b = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: frames), (try? f.read(into: b)) != nil, b.frameLength > 0 {
      let m = b.format.sampleRate == 16000 && b.format.channelCount == 1 ? b : (AVAudioConverter(from: b.format, to: mono16).flatMap { convert($0, b) } ?? b)
      live.feed(m, atMs: ms)
      ms += Double(b.frameLength) / f.processingFormat.sampleRate * 1000
    }
    await live.finish()
    done.signal()
  }
  _ = done.wait(timeout: .now() + 600)
  outQ.sync {}
  exit(0)
  #else
  fail("speech-file needs a build made with Xcode 26 or newer")
  #endif
}
// Apple's speech models: which locales there are and which are on this Mac; installing one downloads it once (no audio involved)
if args.count >= 2, args[1] == "speech-locales" || args[1] == "speech-install" {
  #if compiler(>=6.2)
  guard #available(macOS 26, *) else {
    print(args[1] == "speech-locales" ? #"{"available":false,"supported":[],"installed":[]}"# : #"{"installed":false}"#)
    exit(0)
  }
  let done = DispatchSemaphore(value: 0)
  Task {
    if args[1] == "speech-locales" {
      let supported = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }.sorted()
      let installed = await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) }.sorted()
      if let d = try? JSONSerialization.data(withJSONObject: ["available": true, "supported": supported, "installed": installed]) { print(String(data: d, encoding: .utf8)!) }
    } else {
      var ok = false
      if args.count >= 3, let locale = speechLocale(args[2], in: await SpeechTranscriber.supportedLocales) {
        let t = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [.audioTimeRange])
        let had = await SpeechTranscriber.installedLocales.contains { $0.identifier(.bcp47) == locale.identifier(.bcp47) }
        if !had, let req = try? await AssetInventory.assetInstallationRequest(supporting: [t]) { try? await req.downloadAndInstall() }
        _ = try? await AssetInventory.reserve(locale: locale)
        ok = await SpeechTranscriber.installedLocales.contains { $0.identifier(.bcp47) == locale.identifier(.bcp47) }
      }
      print(#"{"installed":"# + (ok ? "true" : "false") + "}")
    }
    done.signal()
  }
  _ = done.wait(timeout: .now() + 900)
  exit(0)
  #else
  print(args[1] == "speech-locales" ? #"{"available":false,"supported":[],"installed":[]}"# : #"{"installed":false}"#)
  exit(0)
  #endif
}
guard args.count >= 4, (args[1] == "record" || args[1] == "join" || args[1] == "inspect" || args[1] == "compact"), let dirArg = argValue("--dir") else {
  fail("usage: yogurt-audio record --dir DIR [--part N --start-ms X] [--speech LOCALE] | join --dir DIR | inspect --dir DIR | compact --dir DIR --out STAGING | speech-locales | speech-install LOCALE")
}
let dir = URL(fileURLWithPath: dirArg)
if args[1] == "inspect" { inspectAudio(dir); exit(0) }
if args[1] == "compact" {
  guard let output = argValue("--out") else { fail("compact: --out is required") }
  compactAudio(dir, into: URL(fileURLWithPath: output)); exit(0)
}
try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
if args[1] == "join" { exit(joinParts(dir)) }
if part > 0 {
  // so join knows where on meeting time this part's files start
  let note = try? JSONSerialization.data(withJSONObject: ["startMs": startOffsetMs])
  try? note?.write(to: dir.appendingPathComponent("part.\(part).json"))
}

switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .notDetermined:
  let s = DispatchSemaphore(value: 0)
  var ok = false
  AVCaptureDevice.requestAccess(for: .audio) { ok = $0; s.signal() }
  s.wait()
  if !ok { send(["t": "warn", "code": "no-mic"]) }
case .denied, .restricted:
  log("no microphone access: allow Lynote NoteTaker in System Settings, Privacy & Security, Microphone")
  send(["t": "warn", "code": "no-mic"])
default: break
}

let recorder = Recorder(dir: dir)
work.async { recorder.start() }

Thread.detachNewThread {
  while let line = readLine() {
    let c = line.trimmingCharacters(in: .whitespaces)
    if !c.isEmpty { work.async { recorder.command(c) } }
  }
  // Yogurt closed the pipe (quit or crashed): keep what we have
  work.async { recorder.finish() }
}

dispatchMain()
