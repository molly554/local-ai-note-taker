// Fictional speech measurements drive the demonstrations; this page never opens a microphone.
import {speechSignal} from './signal.mjs';
const response=await fetch(new URL('./assets/speech-data.json',import.meta.url));
if(!response.ok) throw new Error('Sample measurements could not be loaded');
const sample=speechSignal(await response.json());
const listeners=new Set(),reduce=matchMedia('(prefers-reduced-motion: reduce)');
const state={phase:0,level:0,bands:[0,0,0]};
let frame,lastTime;
function draw(){
  const value=sample(state.phase);
  state.level=value.level;state.bands=value.bands;
  for(const render of listeners) render(state);
}
function tick(now){
  if(lastTime!==undefined) state.phase+=Math.min((now-lastTime)/1000,.05);
  lastTime=now;draw();frame=requestAnimationFrame(tick);
}
function sync(){
  cancelAnimationFrame(frame);lastTime=undefined;draw();
  if(listeners.size&&!document.hidden&&!reduce.matches) frame=requestAnimationFrame(tick);
}
export function onVoiceFrame(render){listeners.add(render);sync();}
reduce.addEventListener('change',sync);document.addEventListener('visibilitychange',sync);
