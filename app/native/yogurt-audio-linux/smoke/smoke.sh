#!/bin/sh
# A PulseAudio with virtual devices (a CI VM has no sound card), tones playing into them, then smoke.py.
# Usage: smoke.sh HELPER
set -eu
helper=$(realpath "$1")
here=$(dirname "$(realpath "$0")")
work=$(mktemp -d)

pulseaudio --kill 2>/dev/null || true
pulseaudio -D -n --exit-idle-time=-1 --load=module-native-protocol-unix --log-target=stderr
for i in 1 2 3 4 5 6 7 8 9 10; do pactl info >/dev/null 2>&1 && break; sleep 0.5; done
pactl info
# the speakers (them), a second output to switch to, and a mic fed by its own sink (me)
pactl load-module module-null-sink sink_name=speakers sink_properties=device.description=Speakers
pactl load-module module-null-sink sink_name=speakers2 sink_properties=device.description=Speakers2
pactl load-module module-null-sink sink_name=micfeed sink_properties=device.description=MicFeed
pactl load-module module-remap-source master=micfeed.monitor source_name=virtmic source_properties=device.description=VirtualMic
pactl set-default-sink speakers
pactl set-default-source virtmic
pactl list short sources

python3 - "$work" <<'EOF'
import math, struct, sys, wave
for name, hz in [("them", 440), ("me", 1000)]:
    with wave.open(f"{sys.argv[1]}/{name}.wav", "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)
        w.writeframes(b"".join(struct.pack("<h", int(12000 * math.sin(2 * math.pi * hz * i / 48000))) for i in range(48000 * 5)))
EOF
(while true; do paplay --device=speakers "$work/them.wav"; done) &
p1=$!
(while true; do paplay --device=micfeed "$work/me.wav"; done) &
p2=$!
sleep 1

status=0
python3 "$here/smoke.py" "$helper" "$work" || status=$?
kill $p1 $p2 2>/dev/null || true
pulseaudio --kill || true
exit $status
