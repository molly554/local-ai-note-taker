#!/usr/bin/env bash
# Smoke test on a Linux runner with no sound card or screen: a PulseAudio daemon with a silent mic and speaker,
# recorders named like call apps, and an X server with a window manager. Usage: smoke/linux.sh path/to/yogurt-system
set -euo pipefail
BIN=$(realpath "$1")
T=$(mktemp -d)
# check NAME PYTHON-CONDITION-ON-v JSON
check() { python3 -c "import json,sys; v=json.loads(sys.argv[1]); assert $2, v; print('ok:', sys.argv[2])" "$3" "$1"; }

# no sound server yet: an empty list, not a hang
check "no server" 'v == []' "$("$BIN" mic-apps)"

pulseaudio --start --exit-idle-time=-1 -n --load=module-native-protocol-unix --load=module-always-sink
pactl load-module module-null-source source_name=fakemic >/dev/null
pactl load-module module-null-sink sink_name=fakespk >/dev/null
check "nothing recording" 'v == []' "$("$BIN" mic-apps)"

# pacat picks record or play from its own name, so the copies record with -r
mkdir -p "$T/zoom" "$T/meter" "$T/flat"
cp "$(command -v pacat)" "$T/zoom/zoom"
cp "$(command -v pacat)" "$T/meter/meter"
cp "$(command -v pacat)" "$T/flat/slack"
"$T/zoom/zoom" -r -d fakemic >/dev/null & ZOOM=$!
"$T/meter/meter" -r -d fakespk.monitor >/dev/null & METER=$!
"$T/flat/slack" -r -d fakemic --property=pipewire.access.portal.app_id=com.slack.Slack >/dev/null &
sleep 2
APPS=$("$BIN" mic-apps)
echo "mic-apps: $APPS"
check "zoom on the mic, with its pid" "any(a['bundleId'] == 'zoom' and a['pid'] == $ZOOM and a['name'] for a in v)" "$APPS"
check "a speaker monitor is not the mic" "all(a['bundleId'] != 'meter' and a['pid'] != $METER for a in v)" "$APPS"
check "a Flatpak app goes by its app id" "any(a['bundleId'] == 'com.slack.Slack' for a in v)" "$APPS"
check "keys like the Mac helper" "all(sorted(a) == ['bundleId', 'name', 'pid'] for a in v)" "$APPS"

check "running apps in the order asked" "v == ['zoom', 'bash']" "$("$BIN" running-apps zoom not-running-here bash)"
check "no ids" "v == []" "$("$BIN" running-apps)"

# window titles through X11
Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
sleep 1
DISPLAY=:99 openbox >/dev/null 2>&1 &
sleep 1
# sleep, not a shell: a shell prompt would set its own title
DISPLAY=:99 xterm -T "Meet - abc-defg-hij" -e sleep 600 >/dev/null 2>&1 &
DISPLAY=:99 xterm -T "Second window" -e sleep 600 >/dev/null 2>&1 &
sleep 3
check "the xterm title" "v['title'] in ('Meet - abc-defg-hij', 'Second window')" "$(DISPLAY=:99 "$BIN" browser-title xterm)"
check "no window for an app that is not open" "v == {'title': None}" "$(DISPLAY=:99 "$BIN" browser-title not-running-here)"
check "no X server (pure Wayland): null" "v == {'title': None}" "$(env -u DISPLAY "$BIN" browser-title xterm)"

# wrong use fails like the Mac helper
if "$BIN" browser-title 2>/dev/null; then echo "browser-title with no id should fail"; exit 1; fi
echo "all Linux smoke checks passed"
