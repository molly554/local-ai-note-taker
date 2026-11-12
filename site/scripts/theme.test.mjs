import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../content/home.html',import.meta.url),'utf8');
const bootstrap=html.match(/<script>\s*(\(function\(\)[\s\S]*?)<\/script>/)[1];
const script=readFileSync(new URL('../public/marketing/theme.mjs',import.meta.url),'utf8').replace('export function','function');
assert.ok(html.indexOf(bootstrap)<html.indexOf('href="/marketing/site.css"'));

function page(saved,{blocked=false}={}){
  const classes=new Set();
  const root={dataset:{theme:'light'},classList:{add:v=>classes.add(v),remove:v=>classes.delete(v)}};
  const toggle={hidden:true,setAttribute(k,v){this[k]=v},addEventListener(k,fn){this[k]=fn}};
  const meta={content:'#ffffff'},icon={},fallback={};
  const frames=[false,true].map(hero=>({classList:{contains:()=>hero},contentDocument:{documentElement:{dataset:{},style:{}}}}));
  const storage=new Map(saved===undefined?[]:[['yogurt-theme',saved]]);
  const context=vm.createContext({
    document:{documentElement:root,querySelector:s=>s==='.theme-toggle'?toggle:meta,
      getElementById:id=>id==='theme-icon'?icon:fallback,querySelectorAll:()=>frames},
    localStorage:{getItem(k){if(blocked)throw Error('denied');return storage.get(k)},setItem(k,v){if(blocked)throw Error('denied');storage.set(k,v)}},
    requestAnimationFrame:fn=>fn(),
  });
  vm.runInContext(bootstrap,context);
  const initial=root.dataset.theme;
  assert.equal(meta.content,initial==='dark'?'#1B1B1D':'#ffffff');
  if(initial==='dark')assert.equal(icon.href,'/marketing/assets/mark-dark.svg');
  vm.runInContext(script,context);
  return {root,toggle,meta,icon,fallback,frames,storage,context,initial};
}

for(const saved of [undefined,'light','dark','invalid']){
  const p=page(saved);
  assert.equal(p.initial,saved==='dark'?'dark':'light');
  assert.equal(p.toggle.hidden,false);
  for(let i=0;i<2;i++){
    const next=p.root.dataset.theme==='dark'?'light':'dark';
    p.toggle.click();
    assert.equal(p.root.dataset.theme,next);
    assert.equal(p.storage.get('yogurt-theme'),next);
    assert.equal(p.toggle['aria-label'],`Switch to ${next==='dark'?'light':'dark'} mode`);
    assert.equal(p.toggle['aria-pressed'],String(next==='dark'));
    assert.equal(p.meta.content,next==='dark'?'#1B1B1D':'#ffffff');
    assert.equal(p.icon.href,`/marketing/assets/mark${next==='dark'?'-dark':''}.svg`);
    assert.equal(p.fallback.type,next==='dark'?'image/svg+xml':'image/png');
    assert.equal(p.frames[0].contentDocument.documentElement.dataset.marketingTheme,next);
    assert.equal(p.frames[1].contentDocument.documentElement.dataset.marketingTheme,'dark');
    assert.equal(page(p.storage.get('yogurt-theme')).initial,next);
  }
  // Lazy frames inherit the current choice before their ready handler reveals them.
  p.context.lateFrame={classList:{contains:()=>false},contentDocument:{documentElement:{dataset:{},style:{}}}};
  vm.runInContext('syncFrameTheme(lateFrame)',p.context);
  assert.equal(p.context.lateFrame.contentDocument.documentElement.dataset.marketingTheme,p.root.dataset.theme);
  vm.runInContext('syncFrameTheme({contentDocument:null})',p.context);
}
const blocked=page('dark',{blocked:true});
assert.equal(blocked.initial,'light');
assert.doesNotThrow(()=>blocked.toggle.click());
assert.equal(blocked.root.dataset.theme,'dark');
assert.equal(blocked.toggle['aria-pressed'],'true');

function luminance(hex){
  const channels=hex.match(/[\da-f]{2}/gi).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
  return channels.reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
}
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
const css=readFileSync(new URL('../public/marketing/site.css',import.meta.url),'utf8');
assert.ok(css.includes('.site-header nav>a:nth-of-type(2)'), 'The new button must not change which mobile nav link is hidden');
const dark=css.match(/:root\[data-theme=dark\]\{color-scheme:dark;([^}]+)\}/)[1];
const tokens=Object.fromEntries([...dark.matchAll(/--([\w-]+):(#[\da-f]+)/gi)].map(([,key,value])=>[key,value]));
const pairs=[
  ['Resting summary and answer','#A7A4AD','#202021'],
  ['Resting transcript bubbles','#A7A4AD','#333335'],
  ['Done cards','#E7E6EB','#202021'],
  ['Ask question','#E7E6EB','#333335'],
  ['Live summary body','#C6C3CC','#202021'],
  ['Live summary fresh ink','#B780FF','#202021'],
  ['Body',tokens.ink,tokens.bg],['Muted',tokens.muted,tokens.bg],
  ['Card body',tokens.ink,tokens.float],['Card muted',tokens.muted,tokens.float],
  ['Accent',tokens.accent,tokens.bg],['Primary button','#ffffff','#6F00FF'],
  ['Primary hover','#ffffff','#6200E0'],['Secondary hover',tokens.ink,'#333335'],
  ['Footer lightest gradient','#ffffff','#8f38ff'],['Footer button','#26242b','#ffffff'],
  ['Folder lightest gradient','#ffffff','#892eff'],['Recorder body','#F7F7FA','#232326'],
  ['Recorder muted','#B9B9C1','#232326'],['Avatar text','#ffffff','#872bff'],
];
for(const [label,fg,bg] of pairs){
  const ratio=contrast(fg,bg);
  assert.ok(ratio>=4.5,`${label}: ${ratio.toFixed(2)}:1`);
  console.log(`${label}: ${ratio.toFixed(2)}:1`);
}
console.log('Theme bootstrap, persistence, denied storage, toggle, frames and contrast passed.');

// Dark fallbacks keep the same complete fixture copy as the app-backed animations.
const {fragmentLines}=await import('../renderer/fragment-transcript.mjs');
const {finalPlan}=await import('../renderer/fragment-summary.mjs');
const {question,answer}=await import('../renderer/timeline.mjs');
const rest=kind=>html.match(new RegExp(`<div class="fragment-rest rest-${kind}"[\\s\\S]*?</figure>`))[0];
const textOf=markup=>markup.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
fragmentLines.forEach(line=>assert.ok(textOf(rest('transcript')).includes(line.text)));
finalPlan.split('\n').forEach(line=>assert.ok(textOf(rest('summary')).includes(line.replace(/^(## |- )/,'').replaceAll('**',''))));
assert.ok(textOf(rest('ask')).includes(question));
answer.split('\n\n').forEach(line=>assert.ok(textOf(rest('ask')).includes(line)));
assert.ok(css.includes('.rest-summary strong{font-weight:600;color:inherit}'));
console.log('Dark fallback copy matches all three renderer fixtures.');

// Drive the real host sequence without opening a browser.
const {stepCircleFrame,speakerEnvelopes}=await import('../public/marketing/timing.mjs');
const sections=readFileSync(new URL('../public/marketing/sections.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
for(const mode of ['desktop','phone','reduced']){
  const events={},observers=[],frames=[];
  let tick;
  const node=()=>({id:'circle',setAttribute(){},removeAttribute(){}});
  const svg={querySelector:()=>({...node(),children:[node(),node(),node()]})};
  const cards=['transcript','summary','ask'].map((fragment,i)=>{
    const step={dataset:{},querySelector:()=>svg};
    return {dataset:{fragment,duration:[6.2,7.2,7.1][i]},closest:()=>step,append(){}};
  });
  const roster={dataset:{},querySelectorAll:()=>[]};
  const context=vm.createContext({
    matchMedia:q=>({matches:q.includes('reduce')?mode==='reduced':mode==='phone',addEventListener(){}}),
    document:{hidden:false,querySelectorAll:()=>cards,querySelector:()=>roster,createElement:()=>{
      const frame={...node(),contentWindow:{messages:[],postMessage(data){this.messages.push(data)}},remove(){this.removed=true}};
      frames.push(frame);return frame;
    }},
    window:{addEventListener:(type,fn)=>events[type]=fn},location:{origin:'https://yogurt.test'},
    IntersectionObserver:class{constructor(fn){observers.push(fn)}observe(){}},
    onVoiceFrame:fn=>tick=fn,syncFrameTheme(){},stepCircleFrame,speakerEnvelopes,
  });
  vm.runInContext(sections,context);
  const seen=cards.map(card=>new Set([card.dataset.state]));
  observers.forEach(observer=>observer(cards.map(target=>({target,isIntersecting:true,intersectionRatio:1}))));
  for(let phase=0;phase<24;phase+=.1){
    for(const frame of frames)if(!frame.ready&&!frame.removed){
      frame.ready=true;events.message({origin:'https://yogurt.test',source:frame.contentWindow,data:{type:'yogurt-fragment-ready'}});
    }
    tick({phase,level:0,bands:[0,0,0]});
    cards.forEach((card,i)=>{
      seen[i].add(card.dataset.state);
      if(card.dataset.live==='true')assert.equal(card.dataset.state,'active');
    });
  }
  if(mode==='desktop')seen.forEach(states=>assert.deepEqual([...states].sort(),['active','done','resting']));
  else{assert.equal(frames.length,0);cards.forEach(card=>assert.equal(card.dataset.state,'done'))}
}
console.log('All three steps traverse resting, active and done; phone/reduced motion stay complete.');
