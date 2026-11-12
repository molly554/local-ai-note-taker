// The fetched meetings as lines of { speaker, startMs, endMs, text }, and a way to load the app's TypeScript as it is.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const here = dirname(fileURLToPath(import.meta.url))
export const data = join(here, 'data')
if (!existsSync(join(data, 'manifest.json'))) throw new Error('No data yet: run  node bench/real-meetings/fetch.mjs  first.')

/**
 * For notes.mjs, which runs in plain Node: the app's source is read without a build step, so an import with no ending
 * gets ".ts". upstream/enhance.ts is the file as it was at the commit this fork started from (db8aaf9); its one
 * import goes to the app's own file, which is unchanged. (search.bench.mjs needs the Store, which needs the project's
 * test runner: it does not use this.)
 */
export function useAppSource() {
  registerHooks({
    resolve(specifier, context, next) {
      // only the app's own files: an installed package's imports are left as they are
      if (/^\.{1,2}\//.test(specifier) && !/\.(mjs|js|ts|json)$/.test(specifier) && !(context.parentURL ?? '').includes('/node_modules/')) {
        if ((context.parentURL ?? '').endsWith('/upstream/enhance.ts')) return next(new URL(`../../app/src/main/${specifier.replace(/^(\.\.\/)+/, '')}.ts`, import.meta.url).href, context)
        return next(`${specifier}.ts`, context)
      }
      return next(specifier, context)
    },
  })
}

/**
 * How the app would have heard a meeting. It knows two voices for sure: the microphone ("You") and the computer's
 * sound (a name when the call app shows who is talking, "Them" otherwise). A room recorded on one microphone is all
 * "You". The meeting's first speaker stands in for the person recording.
 */
export const MODES = {
  'call, names shown': (l, me) => (l.speaker === me ? { track: 'me', speaker: null } : { track: 'them', speaker: l.speaker }),
  'call, no names': (l, me) => ({ track: l.speaker === me ? 'me' : 'them', speaker: null }),
  'one microphone': () => ({ track: 'me', speaker: null }),
}
/** the meeting's lines as the Store's segments */
export const segmentsOf = (m, mode) => m.lines.map((l, i) => ({ id: i, meetingId: m.id, startMs: l.startMs, endMs: l.endMs, text: l.text, ...MODES[mode](l, m.lines[0].speaker) }))

/** AISHELL-4, test set: 20 meetings in Mandarin, written down by people, with who spoke and when */
export function aishell4() {
  const dir = join(data, 'aishell4')
  return readdirSync(dir).filter((f) => f.endsWith('.TextGrid')).sort().map((f) => {
    const lines = []
    // one tier a speaker; an interval is a stretch of time and what was said in it ("<sil>" and the like are marks, not words)
    for (const tier of readFileSync(join(dir, f), 'utf8').split(/\n\s*item \[\d+\]:/).slice(1)) {
      const speaker = /name = "([^"]*)"/.exec(tier)?.[1] ?? '?'
      for (const m of tier.matchAll(/xmin = ([\d.]+)\s+xmax = ([\d.]+)\s+text = "([^"]*)"/g)) {
        const text = m[3].replace(/<[^>]{0,12}>/g, '').replace(/\s+/g, ' ').trim()
        if (text) lines.push({ speaker, startMs: Math.round(+m[1] * 1000), endMs: Math.round(+m[2] * 1000), text })
      }
    }
    return { id: f.replace('.TextGrid', ''), lines: lines.sort((a, b) => a.startMs - b.startMs) }
  })
}

// QMSum and VCSum carry no times: five seconds a line, only so the app has a meeting length to work with
const timed = (rows) => rows.filter((r) => r.text).map((r, i) => ({ ...r, startMs: i * 5000, endMs: i * 5000 + 5000 }))

/** QMSum's product meetings (AMI) and academic meetings (ICSI): 196 meetings in English, written down by people */
export function qmsum() {
  const dir = join(data, 'qmsum'), out = []
  for (const f of readdirSync(dir).sort()) {
    readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l.trim()).forEach((l, i) => {
      // "{vocalsound}", "{disfmarker}": the annotators' marks, not speech
      out.push({ id: `${f.replace('.jsonl', '')}-${i}`, lines: timed(JSON.parse(l).meeting_transcripts.map((t) => ({ speaker: String(t.speaker), text: String(t.content).replace(/\{[^}]{0,20}\}/g, '').replace(/\s+/g, ' ').trim() }))) })
    })
  }
  return out
}

/** VCSum: 239 round-table meetings in Mandarin, turned into text by a speech-to-text service, a sentence a line */
export function vcsum() {
  return readFileSync(join(data, 'vcsum', 'overall_context.txt'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
    const m = JSON.parse(l)
    return { id: `vcsum-${m.id}`, lines: timed(m.context.flatMap((turn, i) => turn.map((s) => ({ speaker: `S${m.speaker[i]}`, text: String(s).replace(/\s+/g, ' ').trim() })))) }
  })
}
