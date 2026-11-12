const root=document.documentElement;
const toggle=document.querySelector('.theme-toggle');

export function syncFrameTheme(frame){
  const frameRoot=frame.contentDocument?.documentElement;
  if(!frameRoot)return;
  // Preserve the original dark hero on the light page; fragments follow the page.
  const theme=frame.classList.contains('hero-renderer')?'dark':root.dataset.theme;
  frameRoot.dataset.marketingTheme=theme;
  frameRoot.style.colorScheme=theme;
}

function render(){
  const dark=root.dataset.theme==='dark';
  toggle.setAttribute('aria-label',dark?'Switch to light mode':'Switch to dark mode');
  toggle.setAttribute('aria-pressed',String(dark));
  document.querySelector('meta[name="theme-color"]').content=dark?'#1B1B1D':'#ffffff';
  document.getElementById('theme-icon').href=dark?'/marketing/assets/mark-dark.svg':'/marketing/assets/mark.svg';
  const fallback=document.getElementById('theme-icon-png');
  fallback.href=dark?'/marketing/assets/mark-dark.svg':'/marketing/assets/favicon-32.png';
  fallback.type=dark?'image/svg+xml':'image/png';
  document.querySelectorAll('.hero-renderer,.fragment-art iframe').forEach(syncFrameTheme);
}

toggle.addEventListener('click',()=>{
  root.classList.add('theme-switching');
  root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';
  try{localStorage.setItem('yogurt-theme',root.dataset.theme)}catch{}
  render();
  requestAnimationFrame(()=>requestAnimationFrame(()=>root.classList.remove('theme-switching')));
});
render();
toggle.hidden=false;
