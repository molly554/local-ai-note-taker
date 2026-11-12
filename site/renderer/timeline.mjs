// All people, words and times here are invented for the marketing demonstration.
export const timing = { notes:8, type:9.5, typed:14, finish:15.5, summaryStart:18, summary:20, ask:24, question:25, send:27.4, answer:29.8, answered:31.3, close:34.6, resume:36.2, transcript:37.4 }
export const duration = 39
export const beats = [['arrival',0],['live',3.3],['notes',12],['finish',15.45],['writing',18],['summary',22.5],['question',26.5],['thinking',28],['answer',33]]
export const mine = '- Leave 30 minutes for a quiet QA pass.\n- Ask design for the square crop after this call.'
export const bullet = 'Note to self: send Ray the asset list by Friday.'
// Fixed, slightly uneven keystrokes keep exports repeatable without a mechanical cadence.
const keyWeights=[...bullet].map((_,index)=>1+(index%4)*.12+(bullet[index-1]===' '?.18:bullet[index-1]===':'?.65:0))
const keyTotal=keyWeights.reduce((sum,weight)=>sum+weight,0)
let keyElapsed=0
const keyTimes=keyWeights.map(weight=>timing.type+(keyElapsed+=weight)/keyTotal*(timing.typed-timing.type))
export const summary = '## Launch plan\nPublish the page Tuesday. Send the announcement Wednesday morning, after checking the links.\n## Next steps\n- **Kara:** Share the release notes draft Friday.\n- **Lincoln:** Send the announcement Wednesday.\n- **You:** Send Ray the asset list by Friday.\n## My reminders\n- Leave 30 minutes for a quiet QA pass.\n- Ask design for the square crop after this call.'
export const question = 'When are we launching?'
export const answer = 'The page goes live Tuesday.\n\nLincoln announces it Wednesday.'
const line = (id, speaker, text, startMs, endMs) => ({ id, meetingId: 'sample-meeting', track: 'them', speaker, speakerColor: ['Kara Moore', 'Ray Mones', 'Lincoln Park'].indexOf(speaker), text, startMs, endMs, hidden: false })
const opening = [
  line(1, 'Kara Moore', 'The launch page is ready for review.', 709000, 712000),
]
const arrivals = [
  { from: 1.5, to: 4.5, line: line(2, 'Ray Mones', 'Support has the checklist. We can publish Tuesday.', 721500, 724500) },
  { from: 5.2, to: 7.5, line: line(3, 'Lincoln Park', 'I’ll send the announcement on Wednesday morning.', 725200, 727500) },
]
const words = (text, fraction) => text.split(' ').slice(0, Math.ceil(text.split(' ').length * Math.max(0, Math.min(1, fraction)))).join(' ')
export function sceneAt(t) {
  const replay = t >= timing.resume
  const meetingTime = replay ? 0 : t
  const transcript = [...opening]
  // Keep future speaker metadata present on every pass; hidden lines never render.
  for (const arrival of arrivals) transcript.push({ ...arrival.line, hidden: meetingTime < arrival.to })
  transcript.sort((a,b) => a.startMs-b.startMs)
  const live = arrivals.find(a => meetingTime >= a.from && meetingTime < a.to)
  const partial = live ? words(live.line.text, (meetingTime-live.from)/(live.to-live.from)) : ''
  return { transcript, partial, partialStart: live?.line.startMs ?? 0,
    state: replay || t < timing.finish ? 'recording' : t < timing.summary ? 'stopped' : 'done',
    status: replay || t < timing.finish ? 'idle' : t < timing.summary ? 'writing' : 'done',
    mine: mine + (!replay && t >= timing.type-1.1 ? '\n- ' + bullet.slice(0,keyTimes.filter(at=>at<=t).length) : ''),
    draft: replay || t < timing.summaryStart ? '' : summary.slice(0,Math.floor(summary.length*Math.min(1,(t-timing.summaryStart)/(timing.summary-timing.summaryStart)))),
    tab: t < timing.notes || t >= timing.transcript ? 'note-transcript-toggle' : t < timing.finish || replay ? 'note-notes-tab' : 'note-summary-tab',
    question: t < timing.question ? '' : question.slice(0,Math.ceil(question.length*Math.min(1,(t-timing.question)/2))),
    answer: t < timing.answer ? '' : words(answer,(t-timing.answer)/(timing.answered-timing.answer)),
  }
}
