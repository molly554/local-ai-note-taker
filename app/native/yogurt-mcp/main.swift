// yogurt-mcp: what an AI app on this Mac (Claude, Cursor, …) starts to read Yogurt's meetings over MCP.
// It only passes messages: the AI app's stdin to Yogurt's socket in the profile folder, and Yogurt's answers to stdout.
// The MCP server itself is in the app (src/main/mcp). Yogurt not open: it is opened in the background first.
import Foundation

setvbuf(stdout, nil, _IONBF, 0)
func fail(_ s: String) -> Never { FileHandle.standardError.write((s + "\n").data(using: .utf8)!); exit(1) }

let env = ProcessInfo.processInfo.environment
let profile = env["YOGURT_USER_DATA"] ?? (NSHomeDirectory() + "/Library/Application Support/Yogurt")
let path = profile + "/mcp.sock"

func connectOnce() -> Int32? {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  if fd < 0 { return nil }
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8)
  guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { fail("Yogurt's folder path is too long for its connection.") }
  withUnsafeMutableBytes(of: &addr.sun_path) { buf in for (i, b) in bytes.enumerated() { buf[i] = b }; buf[bytes.count] = 0 }
  let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
  if ok == 0 { return fd }
  close(fd); return nil
}

var fd = connectOnce()
if fd == nil && env["YOGURT_MCP_NO_LAUNCH"] == nil {
  // -g: in the background, so starting a chat never pulls Yogurt in front
  let open = Process()
  open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
  open.arguments = ["-g", "-b", "so.yogurt.app"]
  try? open.run(); open.waitUntilExit()
  for _ in 0..<60 { if let f = connectOnce() { fd = f; break }; usleep(500_000) }
}
guard let sock = fd else { fail("Yogurt isn't running, and it couldn't be opened. Open Yogurt, then try again.") }

// Yogurt's answers → stdout; when Yogurt goes away, so does this
Thread.detachNewThread {
  var buf = [UInt8](repeating: 0, count: 65536)
  while true {
    let n = read(sock, &buf, buf.count)
    if n <= 0 { exit(0) }
    var off = 0
    while off < n { let w = buf.withUnsafeBufferPointer { write(1, $0.baseAddress! + off, n - off) }; if w <= 0 { exit(0) }; off += w }
  }
}
// the AI app's messages → Yogurt; the app closing stdin ends the session
var buf = [UInt8](repeating: 0, count: 65536)
while true {
  let n = read(0, &buf, buf.count)
  if n <= 0 { shutdown(sock, SHUT_WR); usleep(200_000); exit(0) }
  var off = 0
  while off < n { let w = buf.withUnsafeBufferPointer { write(sock, $0.baseAddress! + off, n - off) }; if w <= 0 { exit(0) }; off += w }
}
