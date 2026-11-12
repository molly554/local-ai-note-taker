// Protocol smoke test for yogurt-audio.exe on a CI runner (node smoke.mjs EXE MODE [ARGS]).
//   basic      no audio devices needed: every subcommand, the files, join/inspect, and record's frames with no devices
//   live       a tone plays from outside this process tree: both tracks must hear it
//   excluded   the tone plays from a child of this process (Yogurt's tree): process loopback must leave it out
//   tone FILE  writes the tone as a wav
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, '../../../e2e/fixtures')
const [exe, mode, extra] = process.argv.slice(2)
let failures = 0
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`)
  if (!ok) failures++
}
const tmp = (name) => mkdtempSync(join(tmpdir(), `yogurt-${name}-`))
const run = (args, opts = {}) => spawnSync(exe, args, { encoding: 'utf8', timeout: 60_000, ...opts })
const json = (s) => { try { return JSON.parse(s) } catch { return undefined } }

function tone(file, seconds = 30) {
  const rate = 48_000, n = rate * seconds
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5 * 32767), 44 + i * 2)
  writeFileSync(file, b)
}

/** stdout of a record run, as frames (the TS side's FrameParser, in short) */
function parse(buf) {
  const frames = []
  let at = 0
  for (;;) {
    const nl = buf.indexOf(10, at)
    if (nl < 0) break
    const m = json(buf.subarray(at, nl).toString())
    at = nl + 1
    if (!m) { frames.push({ t: 'bad' }); continue }
    if (m.t === 'pcm') {
      if (buf.length < at + m.n * 4) { frames.push({ t: 'torn' }); break }
      let sum = 0
      for (let i = 0; i < m.n; i++) { const x = buf.readFloatLE(at + i * 4); sum += x * x }
      frames.push({ ...m, rms: Math.sqrt(sum / Math.max(1, m.n)) })
      at += m.n * 4
    } else frames.push(m)
  }
  return frames
}

/** Records for ms, sending stdin commands at given times, then stop; resolves with frames, stderr, exit code */
function record(dir, ms, commands = [], args = []) {
  return new Promise((done) => {
    const child = spawn(exe, ['record', '--dir', dir, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = [], err = []
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => { err.push(d); process.stderr.write(`  helper: ${d}`) })
    for (const [at, c] of commands) setTimeout(() => child.stdin.write(c + '\n'), at)
    const started = Date.now()
    setTimeout(() => child.stdin.write('stop\n'), ms)
    const kill = setTimeout(() => child.kill(), ms + 15_000)
    child.on('exit', (code) => {
      clearTimeout(kill)
      done({ frames: parse(Buffer.concat(out)), stderr: Buffer.concat(err).toString(), code, stoppedIn: Date.now() - started - ms })
    })
  })
}

function protocolChecks(frames, label) {
  check(!frames.some((f) => f.t === 'bad' || f.t === 'torn'), `${label}: every line is JSON and every pcm payload is whole`)
  const known = new Set(['pcm', 'level', 'warn', 'mic', 'speech-off'])
  check(frames.every((f) => known.has(f.t)), `${label}: only messages the app knows`)
  const codes = new Set(['no-system-audio', 'device-changed', 'no-mic', 'mic-gone'])
  check(frames.filter((f) => f.t === 'warn').every((f) => codes.has(f.code)), `${label}: warnings are known codes`)
  const levels = frames.filter((f) => f.t === 'level')
  check(levels.every((l) => l.me >= 0 && l.me <= 1 && l.them >= 0 && l.them <= 1), `${label}: levels are 0..1`)
  for (const track of ['me', 'them']) {
    const pcm = frames.filter((f) => f.t === 'pcm' && f.track === track)
    check(pcm.every((p) => Number.isInteger(p.ms) && p.n > 0 && p.n <= 1600), `${label}: ${track} pcm frames are at most 100 ms`)
    // within one run of audio, each frame starts where the last ended
    let steps = 0, ok = 0
    for (let i = 1; i < pcm.length; i++) if (pcm[i - 1].n === 1600) { steps++; if (Math.abs(pcm[i].ms - pcm[i - 1].ms - 100) <= 1) ok++ }
    check(steps === 0 || ok / steps > 0.9, `${label}: ${track} frames follow on`, `${ok}/${steps}`)
  }
}

async function basic() {
  check(json(run(['speech-locales']).stdout)?.available === false, 'speech-locales says Apple speech is not here')
  check(json(run(['speech-install', 'en-US']).stdout)?.installed === false, 'speech-install installs nothing')
  const mics = json(run(['mic-devices']).stdout)
  check(Array.isArray(mics?.devices), 'mic-devices lists microphones', JSON.stringify(mics))
  const usage = run(['nonsense'])
  check(usage.status === 1 && usage.stderr.includes('usage:'), 'unknown commands print usage and fail')

  // the encoder and files, from the committed two-track meeting
  const env = { ...process.env, YOGURT_AUDIO_TEST: '1' }
  const me = join(fixtures, 'meeting-me.wav'), them = join(fixtures, 'meeting-them.wav')
  const a = tmp('probe')
  const probe = run(['writer-probe', '--dir', a, '--me', me, '--them', them], { env, input: 'finish\n' })
  const fed = json(probe.stdout.split('\n')[0])
  check(probe.status === 0 && fed?.t === 'writer-fed', 'writer-probe feeds the fixtures', probe.stderr)
  const info = json(run(['inspect', '--dir', a]).stdout)
  check(Math.abs(info?.durationMs - fed?.inputMs) <= 1, 'a finished file is exactly as long as its audio', `${info?.durationMs} vs ${fed?.inputMs}`)
  check(info?.tracks?.me?.formatID === 0x6f707573 && info?.tracks?.them?.sampleRate === 48000, 'inspect describes Opus 48 kHz tracks')
  const kbps = info?.tracks?.me?.bitsPerSecond / 1000
  check(kbps > 10 && kbps < 30, 'about 20 kb/s', `${kbps}`)
  const head = readFileSync(join(a, 'me.ogg'))
  check(head.subarray(0, 4).toString() === 'OggS' && head.includes(Buffer.from('OpusHead')), 'me.ogg is Ogg Opus')

  // a crash: no last page, still readable up to the last whole second
  const c = tmp('crash')
  const crashed = run(['writer-probe', '--dir', c, '--me', me, '--them', them], { env, input: '' })
  const cinfo = json(run(['inspect', '--dir', c]).stdout)
  check(crashed.status === 0 && cinfo?.durationMs > fed.inputMs - 1100 && cinfo?.durationMs <= fed.inputMs, 'a crashed file keeps all but the last second', `${cinfo?.durationMs}`)

  // a restart is part 1 at 20 s; join puts it there
  const j = tmp('join')
  for (const t of ['me', 'them']) { copyFileSync(join(a, `${t}.ogg`), join(j, `${t}.ogg`)); copyFileSync(join(a, `${t}.ogg`), join(j, `${t}.1.ogg`)) }
  writeFileSync(join(j, 'part.1.json'), '{"startMs":20000}')
  check(run(['inspect', '--dir', j]).status === 1, 'inspect refuses unjoined parts')
  const joined = run(['join', '--dir', j])
  check(joined.status === 0, 'join succeeds', joined.stderr)
  const files = readdirSync(j).sort()
  check(!files.includes('me.1.ogg') && !files.includes('part.1.json'), 'join removes the parts after it worked', files.join(' '))
  check(readdirSync(join(j, 'original')).length === 4, 'join keeps every exact input under original/')
  const jinfo = json(run(['inspect', '--dir', j]).stdout)
  check(Math.abs(jinfo?.durationMs - (20000 + fed.inputMs)) <= 1, 'the joined file runs on meeting time', `${jinfo?.durationMs}`)

  // record with whatever the runner has (often no audio devices at all): it must still speak the protocol and stop cleanly
  const r = tmp('record')
  const res = await record(r, 2500, [[600, 'pause'], [1000, 'resume'], [1300, 'mic auto'], [1500, 'mic {not-a-mic}']], ['--speech', 'en-US'])
  protocolChecks(res.frames, 'no devices')
  check(res.code === 0 && res.stoppedIn < 5000, 'record stops cleanly on stop', `code ${res.code}, ${res.stoppedIn} ms`)
  const levels = res.frames.filter((f) => f.t === 'level').length
  check(levels >= 15 && levels <= 30, 'levels come 10 times a second', `${levels} in 2.5 s`)
  const micFrames = res.frames.filter((f) => f.t === 'mic')
  check(micFrames.length >= 2, 'the mic in use is reported at start and on each mic command', `${micFrames.length}`)
  check(res.frames.some((f) => f.t === 'speech-off'), '--speech answers speech-off')
  const noDevices = !(mics?.devices?.length)
  if (noDevices) {
    check(micFrames[0]?.uid === null && micFrames[0]?.name === null, 'no microphone: Auto with no name')
    // process loopback may start with no speakers at all (it then hears silence); the whole-output fallback can't
    const sysStarted = /system audio: /.test(res.stderr)
    check(sysStarted || res.frames.some((f) => f.t === 'warn' && f.code === 'no-system-audio'), 'no output device: no-system-audio')
  }
  // end of input stops it too, keeping what was recorded
  const eof = spawnSync(exe, ['record', '--dir', tmp('eof')], { input: '', timeout: 15_000 })
  check(eof.status === 0, 'closing stdin stops record', `${eof.status}`)
  const part = tmp('part')
  await record(part, 800, [], ['--part', '2', '--start-ms', '61000'])
  check(json(readFileSync(join(part, 'part.2.json'), 'utf8'))?.startMs === 61000, 'a restart notes where its part starts')
}

async function live(excluded) {
  const mics = json(run(['mic-devices']).stdout)
  console.log('microphones:', JSON.stringify(mics))
  const cable = mics?.devices?.find((d) => /CABLE/i.test(d.name))
  let player
  if (excluded) {
    // a child of this process: in the tree process loopback leaves out, like Yogurt's own players
    const wav = join(tmp('tone'), 'tone.wav')
    tone(wav)
    player = spawn('powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${wav}').PlaySync()`], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 1500))
  }
  const dir = tmp('live')
  const cmds = cable ? [[3000, `mic ${cable.uid}`], [5000, 'mic auto']] : []
  const res = await record(dir, 8000, cmds)
  player?.kill()
  protocolChecks(res.frames, excluded ? 'excluded' : 'live')
  check(res.code === 0, 'record stops cleanly', `${res.code}`)
  const loud = (track) => res.frames.filter((f) => f.t === 'pcm' && f.track === track && f.rms > 0.02).length
  const processLoopback = /every app except Yogurt/.test(res.stderr)
  console.log(`system audio mode: ${processLoopback ? 'process loopback' : 'whole output'}; loud frames me ${loud('me')}, them ${loud('them')}`)
  if (process.env.YOGURT_AUDIO_LOOPBACK === 'endpoint') check(/the whole output/.test(res.stderr), 'the fallback records the whole output')
  else check(processLoopback, 'process loopback starts on this Windows')
  if (excluded && processLoopback) check(loud('them') <= 2, "Yogurt's own sound is left out of them", `${loud('them')} loud frames`)
  else check(loud('them') >= 30, 'them hears the computer\'s sound', `${loud('them')} loud frames`)
  check(res.frames.some((f) => f.t === 'level' && f.them > 0.3) === !(excluded && processLoopback), 'them levels follow the sound')
  if (cable) {
    check(loud('me') >= 30, 'me hears the cable microphone', `${loud('me')} loud frames`)
    const switched = res.frames.filter((f) => f.t === 'mic').map((f) => f.uid)
    check(switched.includes(cable.uid) && switched.at(-1) === null, 'mic ID and mic auto switch without stopping', JSON.stringify(switched))
    check(res.frames.some((f) => f.t === 'warn' && f.code === 'device-changed'), 'a switch says device-changed')
  }
  const info = json(run(['inspect', '--dir', dir]).stdout)
  check(info?.durationMs > 6500 && info?.durationMs < 9500, 'the files cover the recording', JSON.stringify(info))
  check(Math.abs((info?.tracks?.me?.durationMs ?? 0) - (info?.tracks?.them?.durationMs ?? 0)) < 30 || !info?.tracks?.me, 'both files end together')
}

/** The runner's microphone privacy switch starts off: the helper says no-mic and records the computer's sound anyway */
async function denied() {
  const res = await record(tmp('denied'), 2500)
  protocolChecks(res.frames, 'denied')
  check(res.code === 0, 'record stops cleanly', `${res.code}`)
  const blocked = /no microphone access/.test(res.stderr)
  console.log(`microphone ${blocked ? 'blocked by privacy settings' : 'allowed'}`)
  if (blocked) check(res.frames.some((f) => f.t === 'warn' && f.code === 'no-mic'), 'a blocked microphone says no-mic')
  check(res.frames.filter((f) => f.t === 'pcm' && f.track === 'them').length >= 15, "the computer's sound records without the mic")
}

if (mode === 'tone') tone(extra)
else if (mode === 'denied') await denied()
else if (mode === 'basic') await basic()
else if (mode === 'live') await live(false)
else if (mode === 'excluded') await live(true)
else { console.error('node smoke.mjs EXE basic|live|excluded | tone FILE'); process.exit(2) }
if (mode !== 'tone') {
  console.log(failures ? `${failures} failed` : 'all passed')
  process.exit(failures ? 1 : 0)
}
