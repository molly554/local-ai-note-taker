// Yogurt's Mac helper: the calendars this Mac already has (iCloud, Google, Exchange… added in System Settings →
// Internet Accounts) through EventKit, and which apps are using the microphone (Core Audio, macOS 14+).
// Prints JSON; errors go to stderr with exit 1.
//   yogurt-mac calendar-status       → {"status":"granted"|"denied"|"notDetermined"}
//   yogurt-mac calendar-auth         → asks once (the system's own prompt), then the status
//   yogurt-mac events FROM TO        → meetings between two ISO dates (all-day and cancelled ones left out)
//   yogurt-mac mic-apps              → [{"bundleId","name","pid"}] of processes using audio input right now
//   yogurt-mac running-apps ID...    → the supplied bundle IDs currently present in NSRunningApplication
//   yogurt-mac browser-title ID      → {"title":string|null}: the front tab's name in Chrome, Arc, Edge, Brave or Safari (only if running)
//   yogurt-mac permissions           → {"mic":"authorized"|"denied"|"restricted"|"notDetermined","systemAudio":0|1|2,"calendar":…,
//                                       "accessibility":bool}
//   yogurt-mac media-auth            → asks once to control each running player (the system's own prompt), then {"players"}
//   yogurt-mac mic-auth              → asks for the microphone once (the system's own prompt), then {"status"}
//   yogurt-mac audio-auth            → asks to record the computer's sound once, then {"status":0|1|2}
//   yogurt-mac media-pause           → {"paused":[bundle ids]}: pauses Music and Spotify, only those running and playing
//   yogurt-mac media-resume ID...    → {"resumed":[bundle ids]}: plays those again, unless they are already playing
//   yogurt-mac mic-devices           → {"devices":[{"uid","name","default":bool}]}: every microphone, and which one the Mac uses now
//   yogurt-mac ax-auth               → asks for Accessibility once (the system's own prompt), then {"trusted":bool}
//   yogurt-mac call-watch MS ID...   → one JSON line every MS ms until stdin closes: the call app's meeting windows as
//                                       accessibility trees {"t","app","windows":[{"title","id","tree"}]}, or {"t","error"}
import AVFoundation
import AppKit
import CoreAudio
import EventKit
import Foundation

let store = EKEventStore()
let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]
let dayIso = ISO8601DateFormatter()
dayIso.formatOptions = [.withFullDate]

func out(_ v: Any) { FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: v, options: [.sortedKeys])); print() }
func fail(_ msg: String) -> Never { FileHandle.standardError.write((msg + "\n").data(using: .utf8)!); exit(1) }
func date(_ s: String) -> Date {
  if let d = iso.date(from: s) { return d }
  let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let d = f.date(from: s) { return d }
  if let d = dayIso.date(from: s) { return d }
  fail("Couldn't read the date \"\(s)\". Use a form like 2026-10-21T15:00:00Z.")
}

func status() -> String {
  let s = EKEventStore.authorizationStatus(for: .event)
  if #available(macOS 14.0, *) { if s == .fullAccess { return "granted" } }
  switch s {
  case .authorized: return "granted"
  case .notDetermined: return "notDetermined"
  case .restricted: return "restricted"
  default: return "denied"
  }
}

func needAccess() { if status() != "granted" { fail("Lynote NoteTaker doesn't have access to Calendar yet. Allow it in System Settings → Privacy & Security → Calendars.") } }

// MARK: Core Audio

func address(_ sel: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}
func audioProcesses() -> [AudioObjectID] {
  var a = address(kAudioHardwarePropertyProcessObjectList)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size) == noErr, size > 0 else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids) == noErr else { return [] }
  return ids
}
func uint(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> UInt32 {
  var a = address(sel), v: UInt32 = 0, size = UInt32(MemoryLayout<UInt32>.size)
  _ = AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v)
  return v
}
func bundleId(_ obj: AudioObjectID) -> String {
  var a = address(kAudioProcessPropertyBundleID), size = UInt32(MemoryLayout<CFString?>.size)
  var s: Unmanaged<CFString>?
  guard AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &s) == noErr, let v = s else { return "" }
  return v.takeRetainedValue() as String
}
func stringProp(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
  var a = address(sel), size = UInt32(MemoryLayout<CFString?>.size)
  var s: Unmanaged<CFString>?
  guard AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &s) == noErr, let v = s else { return nil }
  return v.takeRetainedValue() as String
}
func defaultInput() -> AudioObjectID {
  var a = address(kAudioHardwarePropertyDefaultInputDevice), dev = AudioObjectID(0), size = UInt32(MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &dev) == noErr else { return 0 }
  return dev
}
/// Every microphone the Mac has, the way Sound settings lists them: devices with an input stream that can be the Mac's
/// input. That leaves out call apps' own virtual devices (ZoomAudioDevice). Aggregate devices are left out too:
/// the recorder makes its own (private) one for system audio.
func inputDevices() -> [[String: Any]] {
  var a = address(kAudioHardwarePropertyDevices), size: UInt32 = 0
  let sys = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(sys, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(sys, &a, 0, nil, &size, &ids) == noErr else { return [] }
  let def = defaultInput()
  return ids.compactMap { d in
    var sa = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
    var ss: UInt32 = 0
    var ca = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceCanBeDefaultDevice, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
    var can: UInt32 = 0, cs = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyDataSize(d, &sa, 0, nil, &ss) == noErr, ss > 0, uint(d, kAudioDevicePropertyIsHidden) == 0,
          AudioObjectGetPropertyData(d, &ca, 0, nil, &cs, &can) == noErr, can != 0,
          let uid = stringProp(d, kAudioDevicePropertyDeviceUID), let name = stringProp(d, kAudioObjectPropertyName) else { return nil }
    if uint(d, kAudioDevicePropertyTransportType) == kAudioDeviceTransportTypeAggregate { return nil }
    return ["uid": uid, "name": name, "default": d == def]
  }
}
func audioApps(input: Bool) -> [[String: Any]] {
  let me = ProcessInfo.processInfo.processIdentifier
  return audioProcesses().compactMap { obj in
    guard uint(obj, input ? kAudioProcessPropertyIsRunningInput : kAudioProcessPropertyIsRunningOutput) != 0 else { return nil }
    let pid = Int32(bitPattern: uint(obj, kAudioProcessPropertyPID))
    if pid == me { return nil }
    let id = bundleId(obj)
    // command-line tools have no app record or bundle id: use the program's name
    var buf = [CChar](repeating: 0, count: 256)
    _ = proc_name(pid, &buf, 256)
    let name = NSRunningApplication(processIdentifier: pid)?.localizedName ?? (id.isEmpty ? String(cString: buf) : id)
    return ["bundleId": id, "name": name, "pid": Int(pid)]
  }
}

// MARK: permissions

func micStatus() -> String {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  default: return "notDetermined"
  }
}
/** Recording the computer's sound (Core Audio taps): TCC's own answer, 0 allowed, 1 denied, 2 not asked */
let tcc = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW)
func audioCapturePermission() -> Int {
  typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int
  guard let h = tcc, let sym = dlsym(h, "TCCAccessPreflight") else { return 2 }
  return unsafeBitCast(sym, to: Preflight.self)("kTCCServiceAudioCapture" as CFString, nil)
}
func requestAudioCapture() {
  typealias Request = @convention(c) (CFString, CFDictionary?, @escaping @convention(block) (Bool) -> Void) -> Void
  guard let h = tcc, let sym = dlsym(h, "TCCAccessRequest") else { return }
  let done = DispatchSemaphore(value: 0)
  unsafeBitCast(sym, to: Request.self)("kTCCServiceAudioCapture" as CFString, nil) { _ in done.signal() }
  _ = done.wait(timeout: .now() + 120)
}

// MARK: music

/** Players that answer AppleScript. `tell application` would launch one that isn't running, so that is checked first. */
let players = ["com.apple.Music", "com.spotify.client"]
func running(_ id: String) -> Bool { !NSRunningApplication.runningApplications(withBundleIdentifier: id).isEmpty }
/**
 * One command to a player, only if it's still running right now (it may have quit since the last look, and
 * `tell` would start it again). The first time, the Mac asks the person to let Yogurt control it; a no reads as nothing.
 */
func tell(_ id: String, _ what: String) -> String? {
  guard running(id) else { return nil }
  var err: NSDictionary?
  return NSAppleScript(source: "tell application id \"\(id)\" to \(what)")?.executeAndReturnError(&err).stringValue
}
func playing(_ id: String) -> Bool { tell(id, "get (player state is playing) as text") == "true" }
func pausePlayers() -> [String] {
  players.filter { playing($0) }.filter { id in
    _ = tell(id, "pause")
    return !playing(id)
  }
}
func resumePlayers(_ ids: [String]) -> [String] {
  ids.filter { players.contains($0) && running($0) && !playing($0) }.filter { id in _ = tell(id, "play"); return true }
}
/** May Yogurt control this player? ask: show the Mac's question if it hasn't been answered. Never launches it. */
func automation(_ id: String, ask: Bool) -> String {
  var target = AEAddressDesc()
  let created = id.withCString { AECreateDesc(typeApplicationBundleID, $0, strlen($0), &target) }
  guard created == noErr else { return "unknown" }
  defer { AEDisposeDesc(&target) }
  switch AEDeterminePermissionToAutomateTarget(&target, typeWildCard, typeWildCard, ask) {
  case noErr: return "granted"
  case OSStatus(errAEEventNotPermitted): return "denied"
  default: return "unknown"
  }
}
func playerStatus(ask: Bool) -> [[String: String]] {
  players.filter(running).map { ["id": $0, "status": automation($0, ask: ask)] }
}

/** The active tab title via AppleScript, or Firefox's focused window via Accessibility. Never launches a browser. */
func browserTitle(_ id: String) -> String? {
  if id == "org.mozilla.firefox" {
    guard AXIsProcessTrusted(), let app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first else { return nil }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.2)
    guard let window = axAttr(root, kAXFocusedWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID() else { return nil }
    return axText(axAttr(window as! AXUIElement, kAXTitleAttribute))
  }
  let safari = id == "com.apple.Safari"
  guard ["com.google.Chrome", "company.thebrowser.Browser", "com.microsoft.edgemac", "com.brave.Browser", "com.apple.Safari"].contains(id),
        !NSRunningApplication.runningApplications(withBundleIdentifier: id).isEmpty else { return nil }
  let src = "tell application id \"\(id)\" to get " + (safari ? "name of current tab of front window" : "title of active tab of front window")
  var err: NSDictionary?
  return NSAppleScript(source: src)?.executeAndReturnError(&err).stringValue
}

// MARK: names from calls (Accessibility)

/**
 * Who is in a call and who is talking, as the call app shows it: its meeting windows copied out of the accessibility
 * tree, read-only (nothing is clicked or changed in the app). Only the call app Yogurt was told about, the frontmost
 * one first. Yogurt reads the tree (src/main/callNames/parse.ts). Chromium and Electron build a page's tree only when
 * an assistive app asks, so they are asked the way screen readers do (AXManualAccessibility), and only for a call window.
 */
let axKeys = [kAXRoleAttribute, kAXSubroleAttribute, kAXDescriptionAttribute, kAXTitleAttribute, kAXValueAttribute, kAXIdentifierAttribute, "AXDOMClassList", kAXChildrenAttribute, kAXSizeAttribute] as [String]
let chromium: Set<String> = ["com.google.Chrome", "company.thebrowser.Browser", "com.brave.Browser", "com.microsoft.edgemac", "com.microsoft.teams", "com.microsoft.teams2"]
var askedTree = Set<pid_t>()

func axAttr(_ e: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}
func axText(_ v: AnyObject?) -> String? {
  guard let s = v as? String, !s.isEmpty else { return nil }
  return s.count > 300 ? String(s.prefix(300)) : s
}

/** one element and what is under it, depth and element count bounded (Zoom's toolbar lists itself as its own child) */
func axCopy(_ e: AXUIElement, depth: Int, maxDepth: Int, budget: inout Int, zoom: Bool) -> [String: Any] {
  budget -= 1
  var raw: CFArray?
  AXUIElementCopyMultipleAttributeValues(e, axKeys as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw)
  let vals = (raw as? [AnyObject]) ?? []
  // a missing attribute comes back as an AXValue error: only real values count
  func at(_ i: Int) -> AnyObject? {
    guard i < vals.count else { return nil }
    let v = vals[i]
    if CFGetTypeID(v) == AXValueGetTypeID() && AXValueGetType(v as! AXValue) == .axError { return nil }
    return v
  }
  var n: [String: Any] = [:]
  let role = axText(at(0)) ?? ""
  n["r"] = role
  if let x = axText(at(1)) { n["s"] = x }
  if let x = axText(at(2)) { n["d"] = x }
  if let x = axText(at(3)) { n["t"] = x }
  // what someone types is never copied
  if role != "AXTextField" && role != "AXTextArea", let x = axText(at(4)) { n["v"] = x }
  if let x = axText(at(5)) { n["i"] = x }
  if let c = at(6) as? [String], !c.isEmpty { n["c"] = Array(c.prefix(20)) }
  if role == "AXTabGroup", let size = at(8), CFGetTypeID(size) == AXValueGetTypeID() {
    var sz = CGSize.zero
    if AXValueGetValue(size as! AXValue, .cgSize, &sz) { n["w"] = Int(sz.width); n["h"] = Int(sz.height) }
  }
  // a Zoom tile's description says it all; its children are buttons
  if zoom && role == "AXTabGroup" { return n }
  guard depth < maxDepth, let kids = at(7) as? [AXUIElement], !kids.isEmpty else { return n }
  var out: [[String: Any]] = []
  for k in kids {
    if budget <= 0 { break }
    out.append(axCopy(k, depth: depth + 1, maxDepth: maxDepth, budget: &budget, zoom: zoom))
  }
  n["k"] = out
  return n
}

/** the windows of a call app that hold the call */
func callWindows(_ app: AXUIElement, _ id: String) -> [AXUIElement] {
  let all = (axAttr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  if id == "us.zoom.xos" {
    return all.filter { w in
      let ident = axText(axAttr(w, kAXIdentifierAttribute)) ?? "", title = axText(axAttr(w, kAXTitleAttribute)) ?? ""
      return ident.hasPrefix("zm.meeting") || title.hasPrefix("Zoom Meeting") || title.hasPrefix("Zoom Webinar")
    }
  }
  if id.hasPrefix("com.microsoft.teams") { return all }
  // a browser: only windows whose front tab is a Meet call
  return all.filter { w in (axText(axAttr(w, kAXTitleAttribute)) ?? "").range(of: #"\bMeet\b"#, options: .regularExpression) != nil }
}

func watchCalls(every: Int, ids: [String]) {
  // Yogurt closes stdin to stop the watch (and a crashed Yogurt closes it too)
  DispatchQueue.global().async { _ = FileHandle.standardInput.readDataToEndOfFile(); exit(0) }
  let line = { (v: [String: Any]) in
    guard let d = try? JSONSerialization.data(withJSONObject: v) else { return }
    FileHandle.standardOutput.write(d); FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  }
  while true {
    let started = Date()
    let t = Int(started.timeIntervalSince1970 * 1000)
    if !AXIsProcessTrusted() {
      line(["t": t, "error": "not-trusted"])
    } else {
      // the frontmost of the apps asked about that shows a call, else the first one that does
      let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
      let running = ids.compactMap { NSRunningApplication.runningApplications(withBundleIdentifier: $0).first }
        .sorted { a, _ in a.processIdentifier == front }
      var found: (NSRunningApplication, AXUIElement, [AXUIElement])?
      for r in running {
        let app = AXUIElementCreateApplication(r.processIdentifier)
        AXUIElementSetMessagingTimeout(app, 0.3)
        let wins = callWindows(app, r.bundleIdentifier ?? "")
        if !wins.isEmpty { found = (r, app, wins); break }
      }
      if let (target, app, wins) = found, let id = target.bundleIdentifier {
        if chromium.contains(id) && !askedTree.contains(target.processIdentifier) {
          AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
          askedTree.insert(target.processIdentifier)
        }
        let zoom = id == "us.zoom.xos"
        var budget = zoom ? 1500 : 4000
        let out = wins.prefix(4).map { w -> [String: Any] in
          var o: [String: Any] = ["tree": axCopy(w, depth: 0, maxDepth: zoom ? 14 : 40, budget: &budget, zoom: zoom)]
          if let x = axText(axAttr(w, kAXTitleAttribute)) { o["title"] = x }
          if let x = axText(axAttr(w, kAXIdentifierAttribute)) { o["id"] = x }
          return o
        }
        line(["t": t, "app": id, "windows": out])
      } else {
        line(["t": t, "error": running.isEmpty ? "not-running" : "no-call-window"])
      }
    }
    // a slow app (a big page) is read less often, so the reading never takes much of the Mac
    let took = Date().timeIntervalSince(started)
    // the run loop turns meanwhile, so the frontmost app stays current
    RunLoop.current.run(until: Date(timeIntervalSinceNow: max(Double(every) / 1000, took * 2)))
  }
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "calendar-status":
  out(["status": status()])
case "calendar-auth":
  let done = DispatchSemaphore(value: 0)
  if #available(macOS 14.0, *) { store.requestFullAccessToEvents { _, _ in done.signal() } }
  else { store.requestAccess(to: .event) { _, _ in done.signal() } }
  _ = done.wait(timeout: .now() + 120)
  out(["status": status()])
case "calendars":
  needAccess()
  out(store.calendars(for: .event).map { c in
    var row = ["id": c.calendarIdentifier, "name": c.title, "source": c.source.title]
    if let color = NSColor(cgColor: c.cgColor)?.usingColorSpace(.sRGB) {
      row["color"] = String(format: "#%02X%02X%02X", Int((color.redComponent * 255).rounded()), Int((color.greenComponent * 255).rounded()), Int((color.blueComponent * 255).rounded()))
    }
    return row
  }.sorted { ($0["source"]! + $0["name"]!) < ($1["source"]! + $1["name"]!) })
case "events":
  needAccess()
  guard args.count >= 3 else { fail("events FROM TO") }
  let from = date(args[1]), to = date(args[2])
  let found = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: nil))
    .filter { !$0.isAllDay && $0.status != .canceled }
    .sorted { $0.startDate < $1.startDate }
    .prefix(200)
  out(found.map { e in
    var o: [String: Any] = [
      "id": (e.eventIdentifier ?? e.title ?? "event") + ":" + iso.string(from: e.startDate),
      "title": e.title ?? "", "start": iso.string(from: e.startDate), "end": iso.string(from: e.endDate), "calendar": e.calendar.title,
      "calendarId": e.calendar.calendarIdentifier, "calendarSource": e.calendar.source.title,
    ]
    if let external = e.calendarItemExternalIdentifier, !external.isEmpty { o["externalId"] = external }
    if let l = e.location, !l.isEmpty { o["location"] = l }
    if let n = e.notes, !n.isEmpty { o["notes"] = String(n.prefix(2000)) }
    if let u = e.url { o["url"] = u.absoluteString }
    // the person using this Mac, apart: their address says which company they are with (Yogurt spells it right)
    if let me = (e.attendees ?? []).first(where: { $0.isCurrentUser }), me.url.absoluteString.hasPrefix("mailto:") { o["me"] = String(me.url.absoluteString.dropFirst(7)) }
    // everyone but the person using this Mac
    o["attendees"] = (e.attendees ?? []).filter { !$0.isCurrentUser }.prefix(50).map { a -> [String: Any] in
      let mail = a.url.absoluteString.hasPrefix("mailto:") ? String(a.url.absoluteString.dropFirst(7)) : nil
      return ["name": a.name ?? mail ?? "", "email": mail as Any? ?? NSNull()]
    }
    return o
  })
case "mic-apps":
  out(audioApps(input: true))
case "running-apps":
  out(args.dropFirst().filter(running))
case "browser-title":
  guard args.count >= 2 else { fail("browser-title BUNDLE_ID") }
  out(["title": browserTitle(args[1]) as Any? ?? NSNull()])
case "permissions":
  // Automation preflights can wait indefinitely on a player; onboarding does not use their result.
  out(["mic": micStatus(), "systemAudio": audioCapturePermission(), "calendar": status(), "accessibility": AXIsProcessTrusted()])
case "media-auth":
  out(["players": playerStatus(ask: true)])
case "mic-auth":
  if micStatus() == "notDetermined" {
    let done = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { _ in done.signal() }
    _ = done.wait(timeout: .now() + 120)
  }
  out(["status": micStatus()])
case "audio-auth":
  if audioCapturePermission() == 2 { requestAudioCapture() }
  out(["status": audioCapturePermission()])
case "media-pause":
  out(["paused": pausePlayers()])
case "media-resume":
  out(["resumed": resumePlayers(Array(args.dropFirst()))])
case "ax-auth":
  out(["trusted": AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)])
case "call-watch":
  guard args.count >= 3, let every = Int(args[1]) else { fail("call-watch MS BUNDLE_ID...") }
  watchCalls(every: max(100, every), ids: Array(args.dropFirst(2)))
case "mic-devices":
  out(["devices": inputDevices()])
default:
  fail("usage: yogurt-mac calendar-status | calendar-auth | events FROM TO | mic-apps | running-apps ID... | browser-title ID | permissions | media-auth | mic-auth | audio-auth | media-pause | media-resume ID... | mic-devices | ax-auth | call-watch MS ID...")
}
