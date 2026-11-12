"""CI smoke test of the Linux yogurt-audio against a real PulseAudio with virtual devices (smoke.sh sets them up):
a 440 Hz tone plays into the default output (them), a 1 kHz tone into a virtual mic (me).
Checks the stdout protocol, the stdin commands, device changes, the Ogg Opus files, and record/join/inspect round trips.
Usage: smoke.py HELPER WORKDIR"""

import json, math, os, struct, subprocess, sys, threading, time

helper, work = sys.argv[1], sys.argv[2]
failures = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what, flush=True)
    if not ok:
        failures.append(what)


def pactl(*a):
    return subprocess.run(["pactl", *a], check=True, capture_output=True, text=True).stdout.strip()


class Run:
    """A recording: the helper's frames as they come, with the time each arrived"""

    def __init__(self, args):
        self.p = subprocess.Popen([helper, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.frames, self.lines, self.raw_lines, self.err = [], [], [], []
        self.t0 = time.time()
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._stderr, daemon=True).start()

    def _stderr(self):
        for l in self.p.stderr:
            s = l.decode(errors="replace").rstrip()
            self.err.append(s)
            print("  helper: " + s, flush=True)

    def _read(self):
        out = self.p.stdout
        while True:
            line = out.readline()
            if not line:
                return
            text = line.decode().rstrip("\n")
            self.raw_lines.append(text)
            m = json.loads(text)
            m["_at"] = time.time() - self.t0
            if m["t"] == "pcm":
                body = out.read(m["n"] * 4)
                m["samples"] = struct.unpack("<%df" % m["n"], body)
            self.lines.append(m)

    def send(self, cmd):
        self.p.stdin.write((cmd + "\n").encode())
        self.p.stdin.flush()

    def wait_for(self, pred, timeout=5.0, since=0):
        end = time.time() + timeout
        while time.time() < end:
            for m in self.lines[since:]:
                if pred(m):
                    return m
            time.sleep(0.05)
        return None

    def stop(self, eof=False):
        if eof:
            self.p.stdin.close()
        else:
            self.send("stop")
        try:
            code = self.p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.p.kill()
            code = "hung"
        time.sleep(0.3)
        return code

    def of(self, t, **kw):
        return [m for m in self.lines if m["t"] == t and all(m.get(k) == v for k, v in kw.items())]


def goertzel(x, hz, rate=16000):
    w = 2 * math.pi * hz / rate
    c = 2 * math.cos(w)
    s1 = s2 = 0.0
    for v in x:
        s1, s2 = v + c * s1 - s2, s1
    return s1 * s1 + s2 * s2 - c * s1 * s2


def rms(x):
    return math.sqrt(sum(v * v for v in x) / max(1, len(x)))


def track_audio(r, track, t_from=0, t_to=1e9):
    out = []
    for m in r.of("pcm", track=track):
        if t_from <= m["ms"] / 1000 <= t_to:
            out.extend(m["samples"])
    return out


def ffprobe_seconds(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True)
    return float(out.stdout.strip())


def ffmpeg_clean(path):
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "null", "-"], capture_output=True, text=True)
    return out.returncode == 0 and not out.stderr.strip()


def mean_db(path):
    out = subprocess.run(["ffmpeg", "-i", path, "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True)
    for l in out.stderr.splitlines():
        if "mean_volume:" in l:
            return float(l.split("mean_volume:")[1].split()[0])
    return -999.0


def inspect(d):
    p = subprocess.run([helper, "inspect", "--dir", d], capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr


# --- small subcommands -------------------------------------------------------------------------------
out = subprocess.run([helper, "speech-locales"], capture_output=True, text=True).stdout.strip()
check(out == '{"available":false,"supported":[],"installed":[]}', "speech-locales says unavailable: " + out)
out = subprocess.run([helper, "speech-install", "en-US"], capture_output=True, text=True).stdout.strip()
check(out == '{"installed":false}', "speech-install says not installed: " + out)
devs = json.loads(subprocess.run([helper, "mic-devices"], capture_output=True, text=True).stdout)["devices"]
print("  mic-devices:", devs)
check(any(d["uid"] == "virtmic" and d["name"] == "VirtualMic" and d["default"] is True for d in devs), "mic-devices lists the virtual mic as the default")
check(not any(d["uid"].endswith(".monitor") for d in devs), "mic-devices leaves out monitors")
bad = subprocess.run([helper, "record"], capture_output=True, text=True)
check(bad.returncode == 1 and "usage:" in bad.stderr, "no --dir: usage and exit 1")

# --- a recording with pause, mic switches and an output switch ----------------------------------------
meet = os.path.join(work, "meeting")
os.makedirs(meet, exist_ok=True)
r = Run(["record", "--dir", meet, "--speech", "en-US"])
check(r.wait_for(lambda m: m["t"] == "speech-off") is not None, "--speech gives speech-off")
mic = r.wait_for(lambda m: m["t"] == "mic")
check(mic is not None and mic["uid"] is None and mic["name"] == "VirtualMic", "mic frame: Auto with the default mic's name: %s" % mic)
time.sleep(4)
r.send("pause")
time.sleep(0.5)
n_pause = len(r.lines)
time.sleep(1.0)
paused_levels = [m for m in r.lines[n_pause:] if m["t"] == "level"]
paused_pcm = [m for m in r.lines[n_pause:] if m["t"] == "pcm"]
check(len(paused_levels) >= 5 and all(m["me"] == 0 and m["them"] == 0 for m in paused_levels), "levels are 0 while paused")
check(not paused_pcm, "no pcm while paused")
r.send("resume")
time.sleep(1.5)

n0 = len(r.lines)
r.send("mic virtmic")
m = r.wait_for(lambda m: m["t"] == "mic" and m["uid"] == "virtmic", since=n0)
check(m is not None and m["name"] == "VirtualMic", "mic UID switches to the chosen mic")
check(r.wait_for(lambda m: m["t"] == "warn" and m["code"] == "device-changed", since=n0) is not None, "a mic switch says device-changed")
n0 = len(r.lines)
r.send("mic nothing-like-this")
m = r.wait_for(lambda m: m["t"] == "mic", since=n0)
check(m is not None and m["uid"] == "virtmic", "an unknown mic changes nothing")
time.sleep(1)

n0 = len(r.lines)
pactl("set-default-sink", "speakers2")
check(r.wait_for(lambda m: m["t"] == "warn" and m["code"] == "device-changed", since=n0, timeout=4) is not None, "a new default output says device-changed")
time.sleep(1)
pactl("set-default-sink", "speakers")
time.sleep(1.5)

# a second mic, chosen, then unplugged: back to Auto with mic-gone
mod = pactl("load-module", "module-remap-source", "master=micfeed.monitor", "source_name=virtmic2", "source_properties=device.description=SecondMic")
time.sleep(0.5)
n0 = len(r.lines)
r.send("mic virtmic2")
check(r.wait_for(lambda m: m["t"] == "mic" and m["uid"] == "virtmic2", since=n0) is not None, "switches to a mic plugged in mid-recording")
time.sleep(1)
n0 = len(r.lines)
pactl("unload-module", mod)
check(r.wait_for(lambda m: m["t"] == "warn" and m["code"] == "mic-gone", since=n0, timeout=5) is not None, "unplugging the chosen mic says mic-gone")
m = r.wait_for(lambda m: m["t"] == "mic" and m["uid"] is None, since=n0, timeout=5)
check(m is not None and m["name"] == "VirtualMic", "and goes back to Auto")
time.sleep(1.5)
r.send("bogus")
elapsed = time.time() - r.t0
code = r.stop()
check(code == 0, "stop exits 0 (got %s)" % code)
check(any("unknown command: bogus" in e for e in r.err), "unknown commands go to stderr")

# protocol shape
for t in ["level", "mic", "warn", "pcm"]:
    raw = next((l for l in r.raw_lines if json.loads(l)["t"] == t), None)
    if raw:
        keys = list(json.loads(raw).keys())
        check(keys == sorted(keys), "%s line has sorted keys: %s" % (t, raw[:80]))
levels = r.of("level")
check(len(levels) >= elapsed * 8, "about 10 levels a second (%d in %.1f s)" % (len(levels), elapsed))
check(max(m["me"] for m in levels) > 0.3 and max(m["them"] for m in levels) > 0.3, "levels hear both tracks")
for track in ["me", "them"]:
    pcm = r.of("pcm", track=track)
    check(len(pcm) > 50, "%s: pcm frames (%d)" % (track, len(pcm)))
    check(all(m["n"] > 0 for m in pcm), "%s: frames carry samples" % track)
    check(all(b["ms"] >= a["ms"] for a, b in zip(pcm, pcm[1:])), "%s: ms never goes back" % track)
    end = max(m["ms"] + m["n"] / 16 for m in pcm)
    check(abs(end / 1000 - elapsed) < 2.0, "%s: pcm reaches meeting time (%.1f s of %.1f s)" % (track, end / 1000, elapsed))
me, them = track_audio(r, "me", 1, 4), track_audio(r, "them", 1, 4)
check(rms(me) > 0.05 and rms(them) > 0.05, "both tracks are not silent (me %.3f, them %.3f)" % (rms(me), rms(them)))
check(goertzel(them, 440) > 20 * goertzel(them, 1000), "them is the speakers' 440 Hz tone")
check(goertzel(me, 1000) > 20 * goertzel(me, 440), "me is the mic's 1 kHz tone")

for track in ["me", "them"]:
    f = os.path.join(meet, track + ".ogg")
    check(os.path.exists(f), f + " exists")
    check(ffmpeg_clean(f), track + ".ogg decodes with ffmpeg without errors")
    sec = ffprobe_seconds(f)
    check(abs(sec - elapsed) < 2.0, "%s.ogg lasts the recording (%.2f s of %.2f s)" % (track, sec, elapsed))
    check(mean_db(f) > -35, "%s.ogg is not silent (%.1f dB)" % (track, mean_db(f)))
code, out, err = inspect(meet)
info = json.loads(out) if code == 0 else {}
print("  inspect:", out.strip())
check(code == 0 and abs(info["durationMs"] / 1000 - ffprobe_seconds(os.path.join(meet, "me.ogg"))) < 0.1, "inspect gives the duration")
check(code == 0 and all(info["tracks"][t]["sampleRate"] == 48000 and info["tracks"][t]["channels"] == 1 and info["tracks"][t]["formatID"] == 0x6F707573 for t in ["me", "them"]), "inspect describes both tracks as Opus")
check(code == 0 and all(0 < info["tracks"][t]["bitsPerSecond"] < 40000 for t in ["me", "them"]), "about 20 kb/s")
first_ms = info.get("durationMs", 0)

# --- a restart: part 1 on meeting time, then join ----------------------------------------------------
r2 = Run(["record", "--dir", meet, "--part", "1", "--start-ms", str(first_ms)])
time.sleep(3)
code = r2.stop(eof=True)
check(code == 0, "end of stdin finishes and exits 0 (got %s)" % code)
pcm = r2.of("pcm", track="them")
check(pcm and pcm[0]["ms"] >= first_ms, "part 1's pcm carries on from --start-ms (%s >= %s)" % (pcm and pcm[0]["ms"], first_ms))
check(os.path.exists(os.path.join(meet, "me.1.ogg")) and os.path.exists(os.path.join(meet, "them.1.ogg")), "part 1 writes me.1.ogg and them.1.ogg")
check(json.load(open(os.path.join(meet, "part.1.json"))) == {"startMs": first_ms}, "part.1.json holds startMs")
part_ms = ffprobe_seconds(os.path.join(meet, "me.1.ogg")) * 1000
code, out, err = inspect(meet)
check(code == 1 and "unjoined parts" in err, "inspect refuses unjoined parts")
j = subprocess.run([helper, "join", "--dir", meet], capture_output=True, text=True)
check(j.returncode == 0, "join exits 0: " + j.stderr)
code, out, err = inspect(meet)
joined = json.loads(out)["durationMs"] if code == 0 else 0
check(abs(joined - first_ms - part_ms) < 1000, "joined length is both parts (%s ~ %s + %s)" % (joined, first_ms, part_ms))
check(sorted(os.listdir(meet)) == ["me.ogg", "original", "them.ogg"], "parts are gone: %s" % sorted(os.listdir(meet)))
check(len(os.listdir(os.path.join(meet, "original"))) == 4, "every original is kept")
check(ffmpeg_clean(os.path.join(meet, "me.ogg")), "the joined file decodes cleanly")

c = subprocess.run([helper, "compact", "--dir", meet, "--out", os.path.join(work, "staging")], capture_output=True, text=True)
check(c.returncode == 0 and c.stdout.strip() == "null", "compact: nothing to do")

# --- no mic at all: the default input is a monitor, so me stays empty --------------------------------
pactl("set-default-source", "speakers.monitor")
time.sleep(0.5)
nomic = os.path.join(work, "nomic")
r3 = Run(["record", "--dir", nomic])
m = r3.wait_for(lambda m: m["t"] == "mic")
time.sleep(2)
r3.stop()
check(m is not None and m["uid"] is None and m["name"] is None, "no mic: the mic frame has no name")
check(not r3.of("pcm", track="me") and r3.of("pcm", track="them"), "no mic: no me audio (never the speakers as me), them still records")
pactl("set-default-source", "virtmic")

print("\n%d failures" % len(failures))
for f in failures:
    print("  " + f)
sys.exit(1 if failures else 0)
