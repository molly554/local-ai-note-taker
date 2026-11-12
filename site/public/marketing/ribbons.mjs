const svg=document.querySelector('.signal-wings');
const reduce=matchMedia('(prefers-reduced-motion: reduce)');
const animations=[];
let visible=false,timer;
const easing='cubic-bezier(.45,0,.55,1)';
function animate(element,frames,name){
  const animation=element.animate(frames.map(frame=>({...frame,easing})),{duration:24000,iterations:Infinity});
  animation.id='ribbon-life-'+name;animation.pause();animations.push(animation);
}
function start(){
  const palettes=[
    ['#ribbon-purple stop:nth-child(1)','color-mix(in srgb,var(--ribbon-warm) 75%,white)','color-mix(in srgb,var(--ribbon-cool) 75%,white)'],
    ['#ribbon-purple stop:nth-child(2)','var(--ribbon-warm)','var(--ribbon-cool)'],
    ['#ribbon-purple stop:nth-child(3)','color-mix(in srgb,var(--brand-soft) 72%,var(--ribbon-warm))','color-mix(in srgb,var(--brand-soft) 72%,var(--ribbon-cool))'],
    ['#ribbon-surface stop:last-child','color-mix(in srgb,var(--brand-deep) 80%,var(--ribbon-warm))','color-mix(in srgb,var(--brand-deep) 80%,var(--ribbon-cool))'],
    ['#ribbon-glint stop:nth-child(2)','color-mix(in srgb,var(--brand-tint) 92%,var(--ribbon-warm))','color-mix(in srgb,var(--brand-tint) 92%,var(--ribbon-cool))'],
  ];
  palettes.forEach(([selector,warm,cool],index)=>{
    const stop=svg.querySelector(selector),base=getComputedStyle(stop).stopColor;
    animate(stop,[base,warm,base,cool,base].map(stopColor=>({stopColor})),'color-'+index);
  });
  animate(svg.parentElement,['0px','var(--ribbon-sway)','0px','calc(-1 * var(--ribbon-sway))','0px'].map(y=>({transform:`translateY(${y})`})),'sway');
}
function sync(){
  if(document.documentElement.dataset.heroEntry!=='complete')return;
  if(!animations.length&&!reduce.matches)start();
  const running=visible&&!document.hidden&&!reduce.matches;
  svg.dataset.running=String(running);
  clearInterval(timer);
  const sway=animations.at(-1);
  if(reduce.matches)animations.forEach(animation=>animation.currentTime=0);
  if(running){
    sway.play();
    // Slow colour travel needs ten paints a second; the sway stays compositor-smooth.
    timer=setInterval(()=>animations.slice(0,-1).forEach(animation=>animation.currentTime=sway.currentTime),100);
  }else sway?.pause();
}
new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;sync()}).observe(svg);
window.addEventListener('hero-entry-complete',sync);
document.addEventListener('visibilitychange',sync);
reduce.addEventListener('change',sync);
sync();
