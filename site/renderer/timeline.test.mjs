import assert from 'node:assert/strict'
import { sceneAt, timing, duration, mine, bullet } from './timeline.mjs'
assert.equal(sceneAt(0).transcript.filter(line=>!line.hidden).length,1)
assert.equal(sceneAt(3).transcript.filter(line=>!line.hidden).length,1)
assert(sceneAt(3).partial.length>0)
assert.deepEqual(sceneAt(7.6).transcript.map(line=>line.speaker),['Kara Moore','Ray Mones','Lincoln Park'])
assert.equal(sceneAt(timing.notes).mine,mine)
assert.equal(sceneAt(timing.type-.5).mine,mine+'\n- ')
assert.equal(sceneAt(timing.typed).mine,mine+'\n- '+bullet)
assert.equal(sceneAt(timing.resume).transcript.filter(line=>!line.hidden).length,1)
assert.equal(duration,39)
assert(Math.abs(timing.answer-timing.send-2.4)<1e-9)
assert.equal(timing.answered-timing.answer,1.5)
console.log('Demo opening, typed bullet, resume and loop timing passed.')

for(const time of [0,2,3,4.6,6,7.6]){
  const scene=sceneAt(time)
  assert.equal(scene.transcript.length,3,'every pass includes the complete speaker metadata')
  if(scene.partial){
    const speaker=scene.transcript.filter(line=>line.startMs<=scene.partialStart).at(-1)
    assert.equal(speaker.startMs,scene.partialStart,'live words inherit their own speaker, never the preceding turn')
    assert(speaker.hidden,'future final text remains hidden while live words arrive')
  }
}
assert.deepEqual(sceneAt(0).transcript,sceneAt(timing.resume).transcript)

const {stepCircleFrame}=await import('../public/marketing/timing.mjs')
for(const span of [7.1,8.1,8]){
  assert.equal(stepCircleFrame(0,span).fill,0)
  assert.equal(stepCircleFrame(.26,span).fill,1)
  assert.equal(stepCircleFrame(.54,span).rebound,0)
  assert.equal(stepCircleFrame(span,span).fill,0)
  assert(stepCircleFrame(span-.08,span).fill>0)
  for(let t=0;t<=span;t+=1/60){
    const frame=stepCircleFrame(t,span)
    assert(frame.fill>=0&&frame.fill<=1)
    assert(Math.abs(frame.rebound)<=1)
    if(t>=.26)assert.equal(frame.blur,0)
  }
}
console.log('Step circle fill, rebound and release timing passed.')

assert.equal(timing.typed-timing.type,4.5)
assert(Math.abs(timing.finish-1.3-timing.typed-.2)<1e-9,'cursor returns 200 ms after typing')
assert.equal(timing.summaryStart-timing.finish,2.5,'preserve the Finish pending beat')
let count=0,last=timing.type
const intervals=[]
for(let t=timing.type;t<=timing.typed+.001;t+=.001){
  const next=sceneAt(t).mine.slice(mine.length+3).length
  assert(next>=count&&next<=count+1,'keystrokes arrive one at a time')
  if(next>count){intervals.push(t-last);last=t;count=next}
}
assert.equal(count,bullet.length)
assert(Math.max(...intervals)>Math.min(...intervals)*1.3,'typing has a slight uneven rhythm')
console.log('Faster notes typing and cursor handoff timing passed.')

const {fragmentLines,fragmentTranscriptAt}=await import('./fragment-transcript.mjs')
for(const [time,index] of [[.8,0],[2.65,1],[4.05,2]]){
  const scene=fragmentTranscriptAt(time)
  const speaker=scene.lines.filter(line=>line.track===scene.partial.track&&line.startMs<=scene.partial.startMs).at(-1)
  assert.equal(speaker.id,fragmentLines[index].id,'live turns have their own speaker from their first word')
  assert(speaker.hidden)
  assert(scene.partial.words.length>0)
}
assert.deepEqual(fragmentTranscriptAt(99).lines,fragmentLines)
console.log('Fragment live speaker metadata and final still passed.')

const {finalPlan,fragmentSummaryAt,summarySettled}=await import('./fragment-summary.mjs')
assert.equal(fragmentSummaryAt(0),'')
assert.equal(fragmentSummaryAt(.95),'## Tuesday')
assert.equal(fragmentSummaryAt(99),finalPlan)
assert.equal(fragmentSummaryAt(summarySettled),finalPlan)
let previous=''
for(let t=0;t<7.2;t+=1/60){
  const next=fragmentSummaryAt(t)
  assert(next.startsWith(previous),'Summary only appends words, including on replay')
  previous=next
}
assert(summarySettled<7.2,'ink settles before the cycle hands off')
console.log('Native Summary stream cadence and completed still passed.')
