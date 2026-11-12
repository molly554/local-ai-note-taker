// The download blob's timeline. All times are seconds.
export type BlobMotion = {
    real: number;
    shown: number;
    time: number;
    home: boolean[];
    eligibleAt: (number | null)[];
    landings: {
        drop: number;
        time: number;
        shown: number;
        waitSeconds: number;
    }[];
    setStartedAt: number | null;
    setElapsed: number;
};
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
export const LAP = 6, LAST_HOME = .965, SET_SECONDS = .8, SOFT_CAP = .8;
export const DROPS = [
    { threshold: .30, angle: -45, r: 8.5, launch: 0, merge: 5.55 },
    { threshold: .55, angle: 180, r: 9, launch: .68, merge: 5.55 },
    { threshold: .75, angle: 90, r: 8, launch: 1.36, merge: 5.55 },
    { threshold: .88, angle: -135, r: 7, launch: 2.04, merge: 5.55 },
    { threshold: .92, angle: 0, r: 6.25, launch: 2.72, merge: 5.55 },
    { threshold: LAST_HOME, angle: -90, r: 5.5, launch: 3.4, merge: 5.25 }
];
const TAU = Math.PI * 2;
const smooth = (v: number) => { const u = clamp(v); return u * u * (3 - 2 * u); };
const phaseOf = (time: number, drop: typeof DROPS[number]) => ((Math.max(0, time - drop.launch) % LAP) + LAP) % LAP;
// A closed path with a nonzero tangent; no resting segment or progress-scaled duration.
export function flight(phase: number) { const a = TAU * phase / LAP; return [51 - 25 * Math.cos(a), -22 * Math.sin(a)]; }
export const firmAt = (p: number) => clamp((p - .70) / (LAST_HOME - .70)) ** 3;
export function createMotion(value = 0): BlobMotion { return { real: value, shown: Math.min(value, LAST_HOME), time: 0, home: DROPS.map(() => false), eligibleAt: DROPS.map(() => null), landings: [], setStartedAt: null, setElapsed: 0 }; }
export function setReal(m: BlobMotion, value: number) {
    const real = clamp(value);
    if (real === 0) {
        Object.assign(m, createMotion());
        return;
    }
    if (real < m.real) {
        // Rewinding starts re-armed drops inside the mass rather than teleporting them outward.
        const rearmed = m.home.some((h, i) => h && real < DROPS[i].threshold);
        m.home = m.home.map((h, i) => h && real >= DROPS[i].threshold);
        m.eligibleAt = m.eligibleAt.map((at, i) => real >= DROPS[i].threshold ? at : null);
        if (rearmed)
            m.time = 0;
        m.setStartedAt = null;
        m.setElapsed = 0;
    }
    m.real = real;
}
export function stepMotion(m: BlobMotion, dt: number) {
    if (m.real === 0)
        return m;
    const previousTime = m.time;
    m.time += dt;
    if (m.setStartedAt !== null) {
        m.setElapsed = clamp(m.time - m.setStartedAt, 0, SET_SECONDS);
        m.shown = LAST_HOME + (1 - LAST_HOME) * smooth(m.setElapsed / SET_SECONDS);
        return m;
    }
    const target = Math.min(m.real, LAST_HOME), delta = target - m.shown;
    m.shown = clamp(m.shown + Math.sign(delta) * Math.min(Math.abs(delta) * (1 - Math.exp(-dt / .18)), .30 * dt));
    if (Math.abs(target - m.shown) < .0001)
        m.shown = target;
    DROPS.forEach((drop, i) => {
        if (m.home[i] || Math.min(m.real, m.shown) < drop.threshold - .00001)
            return;
        m.eligibleAt[i] ??= m.time;
        const age = m.time - drop.launch, phase = phaseOf(m.time, drop);
        // Retire inside the tile on the first eligible rejoin, independent of other drops.
        // A delayed renderer frame can cross the entire inside interval; do not add another lap.
        const crossedMerge = m.eligibleAt[i]! <= previousTime && Math.floor((previousTime - drop.launch - drop.merge) / LAP) < Math.floor((m.time - drop.launch - drop.merge) / LAP);
        if (m.time <= drop.launch || (age >= drop.merge && (phase >= drop.merge || crossedMerge))) {
            m.home[i] = true;
            m.landings.push({ drop: i + 1, time: +m.time.toFixed(3), shown: +(m.shown * 100).toFixed(2), waitSeconds: +(m.time - m.eligibleAt[i]!).toFixed(3) });
        }
    });
    if (m.home.every(Boolean) && m.real === 1 && m.shown >= LAST_HOME) {
        m.setStartedAt = m.time;
        m.setElapsed = 0;
    }
    return m;
}
export function shapeAt(m: BlobMotion, reduced = false) {
    const base = Math.min(firmAt(m.shown), SOFT_CAP), set = reduced ? 1 : smooth(m.setElapsed / SET_SECONDS), firm = reduced ? 1 : base + (1 - SOFT_CAP) * set;
    const q = 1 - firm, b = Math.sin(TAU * m.time / 8), gain = 1 + 17 * q;
    const drops = DROPS.map((drop, i) => {
        const [x, y] = flight(phaseOf(m.time, drop)), a = drop.angle * Math.PI / 180;
        return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a), r: reduced || m.home[i] || m.real === 0 || m.time <= drop.launch ? 0 : drop.r };
    });
    return { firm, set, rim: set, blur: (2.5 - 1.625 * base) * (1 - set), gain, bias: (1 - gain) / 2, displacement: 8 * q, cornerExtra: 57 * (1 - firm ** 3),
        scaleX: 1 + .04 * q * b, scaleY: 1 - .03 * q * b, angle: 3 * q * Math.sin(TAU * (m.time + 1.2) / 8), drops,
        lobes: [{ x: -29 + 4 * q * b, y: -21 - 3 * q * b, r: 11 * q ** 1.2 }, { x: 28 - 4 * q * b, y: 23 + 4 * q * b, r: 10 * q ** 1.2 }] };
}
