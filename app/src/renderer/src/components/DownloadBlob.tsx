import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { createMotion, setReal, shapeAt, stepMotion, SET_SECONDS } from '../../../shared/downloadBlob';
import { MARK } from '../../../shared/logo';
import { useReducedMotion } from '../motion';
/** Dock icon art: only the purple mass is filtered; the white mark stays crisp. */
export function DownloadBlob({ fraction, paused = false, onShown }: {
    fraction: number;
    paused?: boolean;
    onShown?(fraction: number): void;
}) {
    const id = useId().replace(/:/g, '');
    const svgRef = useRef<SVGSVGElement>(null);
    const motion = useRef(createMotion());
    const shimmer = useRef(false);
    const wake = useRef(() => { });
    const report = useRef(onShown);
    report.current = onShown;
    const reduced = useReducedMotion();
    useLayoutEffect(() => {
        const svg = svgRef.current!;
        const get = <T extends SVGElement>(selector: string) => svg.querySelector<T>(selector)!;
        const mass = get('.mass'), mark = get('.mark-motion'), group = get('.goo-group'), rim = get('.icon-rim');
        const blur = get('.blur'), warp = get('.displacement'), threshold = get('.threshold'), finish = get('.finish-shimmer');
        const drops = Array.from(svg.querySelectorAll<SVGCircleElement>('.drop')), lobes = Array.from(svg.querySelectorAll<SVGCircleElement>('.lobe'));
        const corners = Array.from(svg.querySelectorAll<SVGRectElement>('.icon-art rect[rx]')).map(el => ({ el, r: Number(el.getAttribute('rx')) }));
        // The layout effect can restart for motion preferences; keep original corner radii.
        corners.forEach(c => { c.r = Number(c.el.dataset.radius ?? c.r); c.el.dataset.radius = String(c.r); });
        let raf = 0, last = 0, lastFirm = -1, lastPercent = -1;
        const circle = (el: SVGCircleElement, c: {
            x: number;
            y: number;
            r: number;
        }) => {
            el.setAttribute('cx', c.x.toFixed(3));
            el.setAttribute('cy', c.y.toFixed(3));
            el.setAttribute('r', c.r.toFixed(3));
        };
        const paint = () => {
            const m = motion.current, s = shapeAt(m, reduced);
            const transform = `translate(120 120) rotate(${s.angle.toFixed(4)}) scale(${s.scaleX.toFixed(5)} ${s.scaleY.toFixed(5)})`;
            mass.setAttribute('transform', transform);
            mark.setAttribute('transform', transform);
            drops.forEach((el, i) => circle(el, s.drops[i]));
            lobes.forEach((el, i) => circle(el, s.lobes[i]));
            if (lastFirm !== s.firm) {
                blur.setAttribute('stdDeviation', String(s.blur));
                warp.setAttribute('scale', String(s.displacement));
                rim.setAttribute('opacity', String(s.rim));
                threshold.setAttribute('values', `1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 ${s.gain} ${s.bias}`);
                corners.forEach(({ el, r }) => el.setAttribute('rx', String(r + s.cornerExtra)));
                if (s.firm === 1)
                    group.removeAttribute('filter');
                else
                    group.setAttribute('filter', `url(#${id}-goo-light)`);
                lastFirm = s.firm;
            }
            const percent = Math.floor((reduced ? m.real : m.shown) * 100 + 1e-8);
            if (percent !== lastPercent) {
                lastPercent = percent;
                report.current?.(percent / 100);
            }
            if (m.setElapsed < SET_SECONDS) {
                shimmer.current = false;
                finish.classList.remove('is-running');
            }
            else if (!shimmer.current && !reduced) {
                shimmer.current = true;
                finish.classList.add('is-running');
            }
        };
        const tick = (now: number) => {
            raf = 0;
            stepMotion(motion.current, last ? (now - last) / 1000 : 0);
            last = now;
            paint();
            if (motion.current.real > 0 && motion.current.shown < 1)
                raf = requestAnimationFrame(tick);
        };
        const resume = () => {
            paint();
            if (!raf && !paused && !reduced && !document.hidden && motion.current.real > 0 && motion.current.shown < 1) {
                last = 0;
                raf = requestAnimationFrame(tick);
            }
        };
        const visibility = () => {
            finish.classList.toggle('is-paused', document.hidden || paused);
            if (document.hidden) {
                cancelAnimationFrame(raf);
                raf = 0;
            }
            else
                resume();
        };
        wake.current = resume;
        finish.classList.toggle('is-paused', paused);
        if (reduced)
            finish.classList.remove('is-running');
        document.addEventListener('visibilitychange', visibility);
        resume();
        return () => { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', visibility); wake.current = () => { }; };
    }, [id, reduced, paused]);
    useEffect(() => { setReal(motion.current, fraction); wake.current(); }, [fraction]);
    return (<svg ref={svgRef} className="ob-download-blob" data-testid="download-blob" viewBox="0 0 240 240" width="240" height="240" aria-hidden="true"><defs>
 <filter id={`${id}-goo-light`} x="0" y="0" width="240" height="240" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
 <feTurbulence type="fractalNoise" baseFrequency=".018 .022" numOctaves="1" seed="9" result="warp"/>
 <feDisplacementMap className="displacement" in="SourceGraphic" in2="warp" scale="10" xChannelSelector="R" yChannelSelector="G"/>
 <feGaussianBlur className="blur" stdDeviation="2.85"/><feColorMatrix className="threshold" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 16.47 -7.735"/>
 </filter><linearGradient id={`${id}-drops-light`} gradientUnits="userSpaceOnUse" x1="-46" y1="-46" x2="-23" y2="46"><stop stopColor="#8f38ff"/><stop offset=".45" stopColor="#6F00FF"/><stop offset="1" stopColor="#5b00d1"/></linearGradient></defs>
 <g className="goo-group" filter={`url(#${id}-goo-light)`}><g className="mass" transform="translate(120 120)"><g fill={`url(#${id}-drops-light)`}><circle className="drop" r="0"/><circle className="drop" r="0"/><circle className="drop" r="0"/><circle className="drop" r="0"/><circle className="drop" r="0"/><circle className="drop" r="0"/><circle className="lobe" r="0"/><circle className="lobe" r="0"/></g><g className="icon-art" transform="scale(0.3898305084745763) translate(-128 -128)"><defs><linearGradient id={`${id}-light-face`} x1="0" y1="0" x2=".25" y2="1"><stop stopColor="#8f38ff"/><stop offset=".45" stopColor="#6F00FF"/><stop offset="1" stopColor="#5b00d1"/></linearGradient><linearGradient id={`${id}-light-rim`} x2=".2" y2="1"><stop stopColor="#d8baff"/><stop offset=".48" stopColor="#b073ff"/><stop offset="1" stopColor="#6200e0"/></linearGradient><filter id={`${id}-light-grain`}><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComposite in2="SourceGraphic" operator="in"/><feBlend in="SourceGraphic" mode="soft-light"/></filter><filter id={`${id}-light-mark-shadow`} x="-30%" y="-20%" width="160%" height="160%"><feDropShadow dx="0" dy="2.5" stdDeviation="2" floodColor="#320073" floodOpacity=".32"/></filter><clipPath id={`${id}-light-face-clip`}><rect x="10" y="10" width="236" height="236" rx="53"/></clipPath></defs><rect x="10" y="10" width="236" height="236" rx="53" fill={`url(#${id}-light-face)`}/><rect x="10" y="10" width="236" height="236" rx="53" fill="#6F00FF" filter={`url(#${id}-light-grain)`} opacity=".18" clipPath={`url(#${id}-light-face-clip)`}/><g className="icon-rim" opacity="0"><rect x="10.8" y="10.8" width="234.4" height="234.4" rx="52.2" fill="none" stroke="#6200e0" strokeWidth="1.6"/><rect x="14" y="14" width="228" height="228" rx="49" fill="none" stroke={`url(#${id}-light-rim)`} strokeWidth="2"/></g></g></g></g><g className="mark-motion" transform="translate(120 120)"><g className="crisp-mark" transform="scale(0.3898305084745763) translate(-128 -128)"><path d={MARK} transform="translate(52.10208070530504 52.10208070530504) scale(1.5179583858938992)" fill="#fff" filter={`url(#${id}-light-mark-shadow)`}/></g></g><defs><clipPath id={`${id}-finish-clip-light`}><rect x="74" y="74" width="92" height="92" rx="20.661016949152543"/></clipPath><linearGradient id={`${id}-finish-light-light`} x1="0" y1="0" x2="1" y2="0"><stop stopColor="#fff" stopOpacity="0"/><stop offset=".5" stopColor="#fff" stopOpacity=".18"/><stop offset="1" stopColor="#fff" stopOpacity="0"/></linearGradient></defs><g className="finish-shimmer" clipPath={`url(#${id}-finish-clip-light)`}><g className="finish-band"><rect x="100" y="40" width="40" height="160" transform="rotate(-25 120 120)" fill={`url(#${id}-finish-light-light)`}/></g></g></svg>);
}
