import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Transcript } from '@app/components/Transcript'
import { Editor } from '@app/components/Editor'
import { AskConversation } from '@app/components/AskConversation'
import { Logo } from '@app/components/Logo'
import { chat, fragment, fragmentChat, fragmentTranscript, meeting } from './bridge.mjs'
import { question, answer } from './timeline.mjs'
import { fragmentLines, fragmentTranscriptAt } from './fragment-transcript.mjs'
import { finalPlan, fragmentSummaryAt, summarySettled } from './fragment-summary.mjs'

const noop = () => {}
const animated = new URLSearchParams(location.search).has('animate')
// Summary and Ask keep their complete layout; Transcript reserves three native turn slots.
if(fragment==='transcript')fragmentTranscript(fragmentLines,{track:'them',startMs:0,text:'',words:[]})
// Keep the completed answer mounted for word reveals; the native waiting row overlays its reserved slot.
if(fragment==='ask')fragmentChat({question,answer:answer+'[1]',status:animated?'waiting':'done'})

type Reveal = {element:HTMLElement;start:number;duration:number}
function reveals(root:HTMLElement) {
  const items:Reveal[]=[]
  const fade=(element:HTMLElement|null,start:number,duration=.28)=>{if(element)items.push({element,start,duration})}
  const words=(element:HTMLElement,start:number,pace:number)=>{
    const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT),nodes:Text[]=[]
    while(walker.nextNode())if(walker.currentNode.textContent?.trim()&&!walker.currentNode.parentElement?.closest('button,time,.sr-only'))nodes.push(walker.currentNode as Text)
    let index=0
    for(const node of nodes){
      const replacement=document.createDocumentFragment()
      for(const text of node.data.split(/(\s+)/)){
        if(!text.trim()){replacement.append(text);continue}
        const word=document.createElement('span');word.className='fragment-word';word.textContent=text
        replacement.append(word);fade(word,start+index++*pace)
      }
      node.replaceWith(replacement)
    }
  }
  if(fragment==='ask'){
    const prompt=root.querySelector<HTMLElement>('.ask-question')!;fade(prompt,1);words(prompt,1,.045)
    fade(root.querySelector('.fragment-byline'),2.05)
    let start=4.45
    root.querySelectorAll<HTMLElement>('.chat-answer>p').forEach(p=>{words(p,start,1.5/answer.split(' ').length);start+=p.textContent!.replace(/1$/,'').trim().split(/\s+/).length*1.5/answer.split(' ').length})
    fade(root.querySelector('.source-citation'),5.95)
  }
  return items
}
export function FragmentScene() {
  const [summaryTime,setSummaryTime]=useState(animated?0:99)
  const [turn,setTurn]=useState<HTMLElement|null>(null)
  const [transcriptRevision,setTranscriptRevision]=useState(0)
  useEffect(()=>{
    let prepared=false,items:Reveal[]=[],transcriptSignature='',measured:HTMLElement|null=null
    const listener=(event:MessageEvent)=>{
      if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='yogurt-fragment-time'||!Number.isFinite(event.data.seconds))return
      const t=Math.max(0,Math.min(99,event.data.seconds))
      if(fragment==='summary')setSummaryTime(t)
      if(fragment==='transcript'){
        const scene=fragmentTranscriptAt(t),signature=JSON.stringify(scene)
        if(signature!==transcriptSignature){transcriptSignature=signature;fragmentTranscript(scene.lines,scene.partial)}
      }
      for(const {element,start,duration} of items){const progress=Math.max(0,Math.min(1,(t-start)/duration));element.style.opacity=String(1-(1-progress)**3)}
      const pending=document.querySelector<HTMLElement>('.fragment-ask .chat-progress')
      if(pending)pending.style.visibility=t>=2.05&&t<4.45?'visible':'hidden'
      document.documentElement.dataset.fragmentPlaying=String(t<20)
    }
    window.addEventListener('message',listener)
    const ready=()=>{
      if(prepared||measured?.isConnected)return
      const target=document.querySelector<HTMLElement>('.ask-turn');if(target)setTurn(target)
      if(!document.querySelector('[data-testid="transcript"][data-loaded=true], [data-testid="fragment-plan"], [data-testid="chat-answer"]')||fragment==='ask'&&!document.querySelector('.fragment-byline'))return
      prepared=true
      void document.fonts.ready.then(()=>requestAnimationFrame(()=>{
        if(fragment==='transcript'&&animated&&!measured){
          measured=document.querySelector<HTMLElement>('[data-testid=transcript]')!
          const turns=[...measured.querySelectorAll<HTMLElement>('.transcript-turn')]
          const sheet=document.createElement('style')
          // Measure the finished native layout while hidden, then reserve it for live speech.
          sheet.textContent=`.fragment-transcript [data-testid=transcript]{height:${measured.getBoundingClientRect().height}px;display:grid;grid-template-rows:${turns.map(turn=>turn.getBoundingClientRect().height+'px').join(' ')};gap:20px}`+turns.map((turn,i)=>{
            const bubble=turn.querySelector('.bubble')!.getBoundingClientRect()
            return `.fragment-transcript .transcript-turn:nth-child(${i+1} of .transcript-turn) .bubble{width:${bubble.width}px;height:${bubble.height}px;flex:none}`
          }).join('')
          document.head.append(sheet)
          fragmentTranscript([],{track:'them',startMs:0,text:'',words:[]})
          prepared=false;setTranscriptRevision(1);return
        }
        if(fragment==='ask'){
          const answer=document.querySelector<HTMLElement>('.chat-answer')!,turn=answer.closest<HTMLElement>('.ask-turn')!
          turn.style.setProperty('--fragment-answer-top',`${answer.getBoundingClientRect().top-turn.getBoundingClientRect().top}px`)
        }
        items=reveals(document.querySelector('.marketing-fragment')!)
        // Export URLs stay finished; live frames are empty before the host exposes them.
        if(animated)for(const {element} of items)element.style.opacity='0'
        document.documentElement.dataset.ready='true'
        parent.postMessage({type:'yogurt-fragment-ready'},location.origin)
      }))
    }
    const observer=new MutationObserver(ready);observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-loaded']});ready()
    return()=>{observer.disconnect();window.removeEventListener('message',listener)}
  },[])
  return <div className={`marketing-fragment fragment-${fragment}`}>
    {fragment==='transcript'&&<Transcript key={transcriptRevision} id={meeting.id} recording inline />}
    {fragment==='summary'&&<div className="fragment-plan">
      <div className="fragment-plan-size" aria-hidden="true"><Editor markdown={finalPlan} editable={false} label="Tuesday launch" testId="fragment-plan-size" className="enhanced" /></div>
      <div className="fragment-plan-live"><Editor markdown={fragmentSummaryAt(summaryTime)} streaming={animated&&summaryTime<summarySettled} editable={false} label="Tuesday launch" testId="fragment-plan" className="enhanced" /></div>
    </div>}
    {fragment==='ask'&&<><AskConversation id={chat.id} initial={chat} panel onSelect={noop} onSource={noop} onDeleted={noop}/>
      {turn&&createPortal(<div className="fragment-byline"><Logo size={20}/><span>Yogurt</span></div>,turn)}</>}
  </div>
}
