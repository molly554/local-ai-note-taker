const reduceMotion=matchMedia('(prefers-reduced-motion: reduce)');
const state=document.documentElement.dataset;
const animations=[],restore=[];
let completed=false,frame;

// The outer endpoints travel along their original rays. The vanishing point,
// stripe angles and spacing never transform. p=1 restores the exact source d.
export function growPath(original,p){
  if(p>=1) return original;
  const points=original.match(/-?\d*\.?\d+/g).map(Number);
  const outer=y=>`${800*(1-p)} ${325+(y-325)*p}`;
  return original.endsWith('Z')?`M${outer(points[1])} 800 325 ${outer(points[5])}Z`:`M${outer(points[1])} 800 325`;
}
function complete(){
  if(completed) return;
  completed=true;
  cancelAnimationFrame(frame);
  restore.forEach(reset=>reset());
  state.ribbonPaint='ready';
  state.heroEntry='complete';
  window.dispatchEvent(new Event('hero-entry-complete'));
}
if(reduceMotion.matches) complete();
else{
  state.heroEntry='running';
  const copyEase='cubic-bezier(.23,1,.32,1)';
  for(const [selector,delay] of [['.yc-pill',0],['.hero-copy h1',70],['.hero-copy p',140],['.hero-actions',210]]){
    animations.push(document.querySelector(selector).animate([
      {opacity:0,transform:'translateY(12px)'},{opacity:1,transform:'translateY(0)'},
    ],{duration:500,delay,easing:copyEase,fill:'backwards'}));
  }
  const product=document.querySelector('.product-window');
  const desktop=matchMedia('(min-width:761px)');
  if(desktop.matches && product.dataset.live!=='true') {
    await new Promise(resolve=>{
      window.addEventListener('hero-renderer-ready',resolve,{once:true});
      reduceMotion.addEventListener('change',event=>{if(event.matches){animations.forEach(animation=>animation.cancel());resolve()}},{once:true});
      desktop.addEventListener('change',event=>{if(!event.matches)resolve()},{once:true});
    });
  }
  if(reduceMotion.matches) complete();
  else {
  const windowDelay=Math.max(0,270-Number(animations[0].currentTime||0));
  // The live app is already dark and mounted; reveal only the whole window.
  animations.push(product.animate([{opacity:0,transform:'translateY(20px)'},{opacity:1,transform:'translateY(0)'}],
    {duration:600,delay:windowDelay,easing:'cubic-bezier(.16,1,.3,1)',fill:'backwards'}));
  const background='ribbon';
  if(background==='ribbon'){
    const svg=document.querySelector('.signal-wings');
    const surface=svg.querySelector('#ribbon-surface');
    const windowBounds=document.querySelector('.product-window').getBoundingClientRect();
    const ribbonBounds=svg.getBoundingClientRect();
    // Start 2px inside the opaque window, not at the distant vanishing point.
    // Both width and height coverage matter at narrow responsive sizes.
    const coveredLength=Math.max(0,Math.min(1,(windowBounds.width-4)/ribbonBounds.width,(windowBounds.height-4)/ribbonBounds.height));
    const ribbonStart=windowDelay+600,bandDuration=350,bandStagger=55;
    const bands=[...svg.querySelectorAll('[data-ribbon-band]')].map((band,index)=>{
      const paths=[...band.querySelectorAll('path')];
      const seam=svg.querySelector(`#ribbon-seam-${index+1}`);
      if(seam) paths.push(seam);
      const geometry=paths.map(path=>({path,d:path.getAttribute('d')}));
      // Keep the original material in fixed SVG coordinates as the path grows.
      // Object-bounding-box gradients would otherwise travel with the end cap.
      const material=surface.cloneNode(true),paint=paths[1];
      const ys=[index*130,(index+1)*130,325];
      material.id=`ribbon-entry-surface-${index}`;
      material.setAttribute('gradientUnits','userSpaceOnUse');
      material.setAttribute('y1',Math.min(...ys));
      material.setAttribute('y2',Math.max(...ys));
      surface.after(material);
      paint.setAttribute('fill',`url(#${material.id})`);
      restore.push(()=>{geometry.forEach(({path,d})=>path.setAttribute('d',d));paint.setAttribute('fill','url(#ribbon-surface)');material.remove()});
      geometry.forEach(({path,d})=>path.setAttribute('d',growPath(d,coveredLength)));
      return geometry;
    });
    // A seekable clock drives d attributes, not a transform or clipping wipe.
    // It starts only after the live window has painted.
    const clock=svg.animate([],{duration:ribbonStart+4*bandStagger+bandDuration,fill:'backwards'});
    animations.push(clock);
    function draw(){
      const time=Number(clock.currentTime)||0;
      state.ribbonPaint=time>=ribbonStart?'ready':'waiting';
      bands.forEach((geometry,index)=>{
        const progress=Math.max(0,Math.min(1,(time-ribbonStart-index*bandStagger)/bandDuration));
        // A short ease-out carries the visible end cap to the page edge.
        const length=coveredLength+(1-coveredLength)*(1-(1-progress)**3);
        geometry.forEach(({path,d})=>path.setAttribute('d',growPath(d,length)));
      });
      if(!completed) frame=requestAnimationFrame(draw);
    }
    frame=requestAnimationFrame(draw);
  }
  Promise.all(animations.map(animation=>animation.finished)).then(complete).catch(()=>{});
  reduceMotion.addEventListener('change',event=>{
    if(!event.matches) return;
    animations.forEach(animation=>animation.cancel());
    complete();
  });
  }
}
