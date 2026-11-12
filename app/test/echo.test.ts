import { describe, expect, it } from 'vitest'
import { dropEcho, echoConfidence, echoIds, isVerbatimCopy, sharedTokens, tokenOverlap, type Moment } from '../src/main/asr/echo'

const seg = (text: string, startMs: number, endMs = startMs + 2000) => ({ text, startMs, endMs })

describe('dropEcho', () => {
  it('keeps only the them segment when the same words show up on me a moment later', () => {
    const me = [seg('we should move the launch', 10_200)]
    const them = [seg('we should move the launch', 10_000)]
    expect(dropEcho(me, them, { echo: true })).toEqual([])
  })

  it('keeps both when the words differ at the same time', () => {
    const me = [seg('I can send the notes tonight', 10_200)]
    const them = [seg('we should move the launch', 10_000)]
    expect(dropEcho(me, them, { echo: true })).toEqual(me)
  })

  it('keeps a me segment that matches words said far away in time', () => {
    const me = [seg('we should move the launch', 60_000)]
    const them = [seg('we should move the launch', 10_000)]
    expect(dropEcho(me, them, { echo: true })).toEqual(me)
  })

  it('ignores case, punctuation and a few missing words', () => {
    const me = [seg('We should move... the launch!', 10_000)]
    const them = [seg('Okay, we should move the launch to Friday.', 9_500)]
    expect(dropEcho(me, them, { echo: true })).toEqual([])
  })

  it('matches a copy that begins before their line (and the speakers\' tail, half a second) has ended, not one that begins later', () => {
    const them = [seg('we should move the launch', 10_000, 12_000)]
    expect(dropEcho([seg('we should move the launch', 12_400, 14_000)], them, { echo: true })).toEqual([])
    expect(dropEcho([seg('we should move the launch', 12_600, 14_000)], them, { echo: true })).toHaveLength(1)
  })

  it('does not drop a short answer like "okay" that them also said', () => {
    expect(dropEcho([seg('okay', 10_000)], [seg('okay', 10_000)], { echo: true })).toHaveLength(1)
  })

  it('works for Japanese, which has no spaces', () => {
    const me = [seg('明日の会議は十時からです', 5_000)]
    const them = [seg('明日の会議は十時からです', 4_800)]
    expect(dropEcho(me, them, { echo: true })).toEqual([])
  })
})

describe('tokenOverlap', () => {
  it('is the share of the shorter text found in the other', () => {
    expect(tokenOverlap('a b c d', 'a b c d e f')).toBe(1)
    expect(tokenOverlap('a b c d', 'a b x y')).toBe(0.5)
    expect(tokenOverlap('', 'a')).toBe(0)
  })
})

describe('dropEcho against everything them said in the window', () => {
  it('drops a me line whose words are spread over two them lines (whisper cut their sentence differently)', () => {
    const me = [seg('I think we should move the launch to next friday', 10_100, 12_600)]
    const them = [seg('okay so I think we will probably move the', 9_000, 11_000), seg('launch to next friday if that works for everyone', 11_000, 13_500)]
    expect(dropEcho(me, them, { echo: true })).toEqual([])
  })
  it('still keeps a me line that shares only a few words with what was said around it', () => {
    const me = [seg('I think we should wait for more data first', 10_100, 12_600)]
    const them = [seg('okay so I think we will probably move the', 9_000, 11_000), seg('launch to next friday if that works for everyone', 11_000, 13_500)]
    expect(dropEcho(me, them, { echo: true })).toEqual(me)
  })
})

describe('echoIds: the sweep after the meeting', () => {
  const line = (id: number, track: 'me' | 'them', text: string, startMs: number, endMs = startMs + 2000) => ({ id, meetingId: 'm', track, text, startMs, endMs, speaker: track === 'me' ? 'me' : null })
  it('finds the me lines that are copies of them lines, whenever their line arrived', () => {
    const segs = [
      line(1, 'them', 'we should move the launch to friday', 10_000),
      line(2, 'me', 'we should move the launch to friday', 10_300),
      line(3, 'me', 'fine by me, I will tell the team', 14_000),
      line(4, 'me', 'okay', 16_000),
      line(5, 'them', 'okay great', 16_100),
    ]
    expect(echoIds(segs, { echo: true })).toEqual([2])
  })
  it('finds nothing without them lines', () => {
    expect(echoIds([line(1, 'me', 'hello there everyone', 0)])).toEqual([])
  })
})

describe('scraps of their sentence on the mic', () => {
  it('a one or two word me line that is a piece of a longer line of theirs said at that moment is an echo', () => {
    const them = [seg('the main responsibility is user interface and my role is to design a remote', 28_000, 32_000)]
    expect(dropEcho([seg('role is', 29_000, 29_600)], them, { echo: true })).toEqual([])
    expect(dropEcho([seg('design a', 30_400, 30_900)], them, { echo: true })).toEqual([])
  })
  it('a short reply of their own words at a different moment, or not in their line, stays', () => {
    const them = [seg('the main responsibility is user interface and my role is to design a remote', 28_000, 32_000)]
    expect(dropEcho([seg('role is', 40_000, 40_600)], them, { echo: true })).toHaveLength(1)
    expect(dropEcho([seg('okay sure', 29_000, 29_600)], them, { echo: true })).toHaveLength(1)
    // both said "okay": too short to tell, so it stays
    expect(dropEcho([seg('okay', 10_000)], [seg('okay', 10_000)], { echo: true })).toHaveLength(1)
  })
  it('a mic line of nothing but filler while they talk is nothing', () => {
    expect(dropEcho([seg('Um...', 10_000, 10_500)], [seg('so that is kind of our brief', 9_000, 12_000)], { echo: true })).toEqual([])
    expect(dropEcho([seg('Um...', 50_000, 50_500)], [seg('so that is kind of our brief', 9_000, 12_000)], { echo: true })).toHaveLength(1)
  })
})

describe('nothing is dropped without evidence of echo (headphones)', () => {
  const themA = [seg('yeah I think we can ship it on Friday if design is right', 10_000, 16_000)]
  const themB = [seg('so I think we should do that now', 9000, 11_000), seg('and yes I can send it so you have it', 11_200, 14_000)]
  it("the person's own short replies and echoes alike stay when no echo was heard in this meeting", () => {
    for (const m of ['Yeah.', 'Right.', 'Friday?', 'Mm-hmm.', 'Okay.', 'Ship it.']) expect(dropEcho([seg(m, 12_000, 12_500)], themA)).toHaveLength(1)
    for (const m of ['Yes, I think so.', 'I can do that.', 'Sounds good, I can send it.']) expect(dropEcho([seg(m, 11_000, 12_500)], themB)).toHaveLength(1)
    expect(dropEcho([seg('we should move the launch', 10_200)], [seg('we should move the launch', 10_000)])).toHaveLength(1)
    // not even a long line copied word for word: only the audio says whether there is echo
    expect(echoIds([{ id: 1, meetingId: 'm', track: 'them', text: 'we should move the launch to friday', startMs: 10_000, endMs: 12_000 }, { id: 2, meetingId: 'm', track: 'me', text: 'we should move the launch to friday', startMs: 10_300, endMs: 12_300 }])).toEqual([])
  })
  it('with echo heard in the meeting, the rules apply: copies, scraps and fillers go, real replies stay', () => {
    const o = { echo: true }
    expect(dropEcho([seg('we should move the launch', 10_200)], [seg('we should move the launch', 10_000)], o)).toEqual([])
    expect(dropEcho([seg('Friday?', 12_000, 12_500)], themA, o)).toEqual([])
    expect(dropEcho([seg('Mm-hmm.', 12_000, 12_500)], themA, o)).toEqual([])
    expect(dropEcho([seg('I can do that.', 11_000, 12_500)], themB, o)).toHaveLength(1)
    expect(dropEcho([seg('Okay.', 12_000, 12_500)], themA, o)).toHaveLength(1)
  })
  it('a long line copied almost word for word is told apart from a reply, for the evidence check', () => {
    expect(isVerbatimCopy(seg('yeah I think we can ship it on Friday', 10_100, 13_000), themA)).toBe(true)
    expect(isVerbatimCopy(seg('Yes, I think so.', 11_000, 12_500), themB)).toBe(false)
    expect(isVerbatimCopy(seg('Sounds good, I can send it.', 11_000, 12_500), themB)).toBe(false)
  })
})

describe("round 2: the reviewer's probes", () => {
  const themA = [seg('yeah I think we can ship it on Friday if design is right', 10_000, 16_000)]
  const themB = [seg('so I think we should do that now', 9000, 11_000), seg('and yes I can send it so you have it', 11_200, 14_000)]
  const always = () => true
  it('with echo heard, short replies survive unless they match nearly whole and the mic really echoed at that moment', () => {
    const o = { echo: true, correlatedAt: always }
    for (const m of ['Yeah.', 'Right.', 'Okay.']) expect(dropEcho([seg(m, 12_000, 12_500)], themA, o), m).toHaveLength(1)
    for (const m of ['Yes, I think so.', 'I can do that.', 'Sounds good, I can send it.']) expect(dropEcho([seg(m, 11_000, 12_500)], themB, o), m).toHaveLength(1)
    // real echoes go
    for (const m of ['I think we can ship it on Friday', 'ship it on Friday', 'and yes I can send it so you have it', 'we should do that now']) expect(dropEcho([seg(m, 11_000, 14_000)], [...themA, ...themB], o), m).toEqual([])
    // the same short echoes stay when the mic did not echo at that moment
    for (const m of ['ship it on Friday', 'we should do that now']) expect(dropEcho([seg(m, 11_000, 14_000)], [...themA, ...themB], { echo: true, correlatedAt: () => false }), m).toHaveLength(1)
  })
  it('a read-back with headphones never turns evidence on and is never hidden', () => {
    const t3 = [seg('Can you send me the report by Friday?', 10_000, 12_500)]
    const rb = [seg('Send you the report by Friday? Sure.', 13_000, 15_000), seg('Yeah.', 15_500, 16_000)]
    const segs = [...t3.map((x, i) => ({ ...x, id: 100 + i, meetingId: 'm', track: 'them' as const })), ...rb.map((x, i) => ({ ...x, id: i, meetingId: 'm', track: 'me' as const }))]
    expect(echoIds(segs)).toEqual([])
    const t4 = [seg('so the deadline is next Friday the 14th', 10_000, 12_500), seg('can you make that work', 12_600, 13_500)]
    const rb2 = [seg('The deadline is next Friday the 14th, okay.', 13_600, 15_500), seg('I can make that work.', 15_600, 16_500)]
    const segs2 = [...t4.map((x, i) => ({ ...x, id: 100 + i, meetingId: 'm', track: 'them' as const })), ...rb2.map((x, i) => ({ ...x, id: i, meetingId: 'm', track: 'me' as const }))]
    expect(echoIds(segs2)).toEqual([])
    // only with echo heard in the audio does the sweep act, and then a read-back a second later is still not an echo of a line at the same moment
    expect(echoIds(segs2, { echo: true, correlatedAt: () => false })).toEqual([])
  })
})

describe("round 4: the line's own audio decides the moment", () => {
  const always = () => true, never = () => false
  const moment = (m: Partial<Moment>): Moment => ({ correlated: false, loud: false, pure: false, ...m })
  const echo = { echo: true, correlatedAt: never }
  it('a line that is nothing but their voice from the speakers goes when their line at that moment has its words, at a lower bar than the word rules', () => {
    const o = { ...echo, over: () => moment({ correlated: true, loud: true, pure: true }) }
    // 3 of 4 words: under the 0.95 the short-line rule wants, enough with the audio behind it
    expect(dropEcho([seg('My name is Eileen.', 40_940, 42_220)], [seg('My name is Aileen.', 41_200, 41_900)], o)).toEqual([])
    expect(dropEcho([seg('that we all know each other.', 23_580, 24_920)], [seg('so first of all just to kind of make sure that we all know', 20_400, 23_940)], o)).toEqual([])
  })
  it('round 5: but never on audio alone: a quiet person whose words whisper garbled, or who talks over something else, stays', () => {
    const o = { ...echo, over: () => moment({ correlated: true, loud: true, pure: true }) }
    expect(dropEcho([seg('- I agree it, okay.', 41_400, 44_100)], [seg('so we are designing a new remote control and I have to', 41_300, 49_000)], o)).toHaveLength(1)
    expect(dropEcho([seg('with the person.', 87_100, 87_600)], [seg('Mm-hmm.', 87_100, 87_700)], o)).toHaveLength(1)
    expect(dropEcho([seg('Let me check the budget numbers first', 10_000, 13_000)], [seg('la la la the night is young', 8_000, 18_000)], o)).toHaveLength(1)
    // the matching line must overlap the mic line in time, not merely be near it
    expect(dropEcho([seg('My name is Eileen.', 40_940, 42_220)], [seg('My name is Aileen.', 39_500, 40_900)], o)).toHaveLength(1)
    expect(sharedTokens('My name is Eileen', 'my name is Aileen and I work in marketing')).toBe(3)
  })
  it("but never the person's short replies: acknowledgements and one or two words stay", () => {
    const them = [seg('so we are designing a new remote control and I have to', 41_300, 49_000)]
    const o = { ...echo, over: () => moment({ correlated: true, loud: true, pure: true }) }
    for (const m of ['Okay.', 'Yeah, right.', 'Yes, thanks, great.', 'with the']) expect(dropEcho([seg(m, 42_000, 42_600)], them, o), m).toHaveLength(1)
  })
  it("a copy of the person's own words on their track (far-end echo) stays: the mic is far louder than the leak", () => {
    const line = "so why don't we look at the presentation"
    const o = { echo: true, correlatedAt: always, over: () => moment({ correlated: true, loud: false }) }
    expect(dropEcho([seg(line, 65_200, 68_900)], [seg(line, 65_300, 68_900)], o)).toHaveLength(1)
  })
  it("while the person talks over them, the line's own correlation drops; the window's verdict still counts, with the level check", () => {
    const them = [seg('and I am a marketing person I want to figure out how to sell them', 35_400, 39_800)]
    const m = seg('I want to figure out how to sell them.', 37_460, 40_040)
    expect(dropEcho([m], them, { echo: true, correlatedAt: always, over: () => moment({ loud: true }) })).toEqual([])
    expect(dropEcho([m], them, { echo: true, correlatedAt: never, over: () => moment({ loud: true }) })).toHaveLength(1)
    expect(dropEcho([m], them, { echo: true, correlatedAt: always, over: () => moment({ loud: false }) })).toHaveLength(1)
  })
  it('with no audio verdict for the span, the windows decide as before', () => {
    const them = [seg('we should move the launch', 10_000, 12_000)]
    expect(dropEcho([seg('we should move the launch', 10_200, 12_000)], them, { echo: true, correlatedAt: always, over: () => undefined })).toEqual([])
    expect(dropEcho([seg('we should move the launch', 10_200, 12_000)], them, { echo: true, correlatedAt: never, over: () => undefined })).toHaveLength(1)
  })
  it('a one-word scrap of a one-word line of theirs, said at that moment, is an echo', () => {
    const o = { echo: true, correlatedAt: always }
    expect(dropEcho([seg('minutes.', 18_540, 20_700)], [seg('minutes.', 18_440, 18_760)], o)).toEqual([])
    expect(dropEcho([seg('Experts.', 37_900, 38_700)], [seg('Experts.', 38_000, 38_700)], o)).toEqual([])
    // an acknowledgement both said stays, as before
    expect(dropEcho([seg('okay', 10_000)], [seg('okay', 10_000)], o)).toHaveLength(1)
  })
})

describe('round 3: a read-back a moment after their line is never an echo', () => {
  const s = (text: string, a: number, b: number) => seg(text, a, b)
  // echo present; the mic followed their track in the 2 s windows while they talked (10 to 12.5 s: windows 5 and 6; 20 to 22.5 s: 10 and 11)
  const corr = new Set([5, 6, 10, 11])
  const at = (ms: number) => corr.has(Math.floor(ms / 2000))
  const them = [s('Can you send me the report by Friday?', 10_000, 12_500), s('so the deadline is next Friday the 14th', 20_000, 22_500)]
  it("the reviewer's read-backs at 13 s and 23 s stay; a copy still inside their line goes", () => {
    for (const m of [s('Send you the report by Friday? Sure.', 13_000, 15_000), s('Send you the report by Friday? Sure.', 15_000, 17_000), s('The deadline is next Friday the 14th, okay.', 23_000, 25_000)]) {
      expect(dropEcho([m], them, { echo: true, correlatedAt: at }), m.text + ' @' + m.startMs).toHaveLength(1)
    }
    expect(dropEcho([s('can you send me the report by Friday', 10_100, 12_400)], them, { echo: true, correlatedAt: at })).toEqual([])
    // a copy that starts just after their line ended (within half a second) is still the speakers' tail
    expect(dropEcho([s('send me the report by Friday', 12_800, 14_000)], them, { echo: true, correlatedAt: at })).toEqual([])
  })
})

describe('echo confidence for the inline disclosure', () => {
  it('silences strong copies, keeps weak word matches reviewable, and keeps real replies', () => {
    const theirs = [seg('we should move the launch to friday morning', 10_000)]
    const o = { echo: true }
    expect(echoConfidence(seg('we should move the launch to friday morning', 10_100), theirs, o)).toBe('high')
    expect(echoConfidence(seg('we should move the launch beyond monday evening', 10_100), theirs, o)).toBe('uncertain')
    expect(echoConfidence(seg('we should move the launch beyond monday evening', 10_100), theirs, { ...o, over: () => ({ pure: true, loud: true, correlated: true }) })).toBe('high')
    expect(echoConfidence(seg('okay', 10_100), theirs, o)).toBe(false)
    expect(echoConfidence(seg('we should move the launch to friday morning', 10_100), theirs)).toBe(false)
    expect(echoConfidence(seg('we should move the launch to friday morning', 10_100), theirs, { ...o, over: () => ({ pure: true, loud: false, correlated: true }) })).toBe(false)
  })
})
