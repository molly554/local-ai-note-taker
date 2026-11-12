import {onVoiceFrame} from './clock.mjs';
const demo=document.querySelector('#product-demo'),reduce=matchMedia('(prefers-reduced-motion: reduce)'),desktop=matchMedia('(min-width:761px)');
let cycleDuration=Infinity;
let frame,ready=false,visible=false,started=false,startPhase,lastSent=-1,last={phase:0,bands:[0,0,0]},override;
const eligible=()=>desktop.matches&&!reduce.matches;
const send=data=>frame?.contentWindow?.postMessage(data,location.origin);
function render(value){
  last=value;
  if(!ready)return;
  const playing=visible&&!document.hidden&&eligible();
  send({type:'yogurt-hero-playing',playing});
  if(!playing)return;
  startPhase??=value.phase;
  const seconds=override??(value.phase-startPhase)%cycleDuration;
  if(override!==undefined||value.phase-lastSent>=.05){
    lastSent=value.phase;
    send({type:'yogurt-hero-time',seconds,bands:value.bands});
  }
  // The pointer follows every paint; heavier fixture updates keep their 20 Hz cadence.
  send({type:'yogurt-hero-cursor',seconds});
}
function load(){
  if(started||!eligible())return;
  started=true;
  frame=document.createElement('iframe');frame.className='hero-renderer';frame.title='Fictional Yogurt meeting';
  frame.tabIndex=-1;frame.inert=true;frame.setAttribute('aria-hidden','true');frame.setAttribute('sandbox','allow-scripts allow-same-origin');
  frame.style.setProperty('--renderer-scale',demo.clientWidth/1000);frame.src='/marketing/app/frame.html';demo.append(frame);
}
window.addEventListener('message',event=>{
  if(ready||event.origin!==location.origin||event.source!==frame?.contentWindow||event.data?.type!=='yogurt-hero-ready')return;
  if(Number.isFinite(event.data.duration)&&event.data.duration>0)cycleDuration=event.data.duration;
  ready=true;render(last);demo.dataset.live='true';window.dispatchEvent(new Event('hero-renderer-ready'));
});
new ResizeObserver(()=>{if(frame)frame.style.setProperty('--renderer-scale',demo.clientWidth/1000)}).observe(demo);
new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;load();render(last)},{threshold:0}).observe(demo);
function mode(){
  if(!eligible()){frame?.remove();frame=undefined;ready=false;started=false;startPhase=undefined;delete demo.dataset.live;}
  else load();
}
reduce.addEventListener('change',mode);desktop.addEventListener('change',mode);
document.addEventListener('visibilitychange',()=>render(last));
// Deterministic browser export drives the same fixture, without a production query switch.
window.addEventListener('hero-capture',event=>{if(Number.isFinite(event.detail)){override=event.detail;render(last)}});
onVoiceFrame(render);load();
