import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ windows: [] as any[], dark: false, theme: new Set<() => void>() }))
vi.mock('electron', () => ({
  BrowserWindow: class {
    options: any; dead = false; listeners = new Map<string, Array<() => void>>()
    setBackgroundColor = vi.fn()
    constructor(options: any) { this.options = options; state.windows.push(this) }
    on(event: string, fn: () => void) { this.listeners.set(event, [...this.listeners.get(event) ?? [], fn]) }
    once(event: string, fn: () => void) { this.on(event, fn) }
    destroy() { this.dead = true; this.listeners.get('closed')?.forEach(fn=>fn()) }
    isDestroyed() { return this.dead }
    loadFile() { return Promise.resolve() }
  },
  ipcMain: { handle: vi.fn() },
  Notification: { isSupported: () => false },
  nativeTheme: {
    get shouldUseDarkColors() { return state.dark },
    on: (_name: string, fn: () => void) => state.theme.add(fn),
    removeListener: (_name: string, fn: () => void) => state.theme.delete(fn),
  },
  screen: { getPrimaryDisplay: () => ({workArea:{x:0,y:0,width:1200,height:800}}) },
}))
vi.mock('../src/main/float', async (real) => ({ ...(await real<typeof import('../src/main/float')>()), floatOverFullScreen: vi.fn() }))
let prompts: ReturnType<typeof import('../src/main/prompts').createPrompts>
beforeEach(async () => {
  vi.stubEnv('YOGURT_BACKGROUND', '1'); vi.resetModules()
  state.windows.length = 0; state.theme.clear(); state.dark = false
  const { createPrompts } = await import('../src/main/prompts')
  prompts = createPrompts({windowVisible:()=>true,takeNotes:vi.fn(),stop:vi.fn(),dismissed:vi.fn(),keepGoing:vi.fn(),open:vi.fn()})
})
afterEach(() => { prompts.hide(); vi.unstubAllEnvs() })
it('keeps the start offer in one compact row without changing the stop confirmation size', () => {
  prompts.offer({key:'call',app:'Zoom',title:'Design review'} as any)
  expect(state.windows[0].options).toMatchObject({width:381,height:60,focusable:false,backgroundColor:'#FFFFFF'})
  prompts.askStop({id:'meeting',title:'Design review'} as any)
  expect(state.windows[1].options).toMatchObject({width:380,height:128})
})
it("a Mac's card is a plain window, as before; Windows and Linux make it a tool window that never takes focus", async () => {
  prompts.offer({key:'call',app:'Zoom',title:''} as any)
  expect(state.windows[0].options.type).toBeUndefined()
  prompts.hide()
  const { createPrompts } = await import('../src/main/prompts')
  const pc = createPrompts({windowVisible:()=>true,takeNotes:vi.fn(),stop:vi.fn(),dismissed:vi.fn(),keepGoing:vi.fn(),open:vi.fn(),os:'win32'})
  pc.offer({key:'call',app:'Zoom',title:''} as any)
  expect(state.windows.at(-1).options).toMatchObject({type:'toolbar',focusable:false,skipTaskbar:true})
  pc.hide()
})
it('uses the current app appearance and updates the native background without leaking listeners', () => {
  state.dark = true
  prompts.offer({key:'call',app:'Zoom',title:''} as any)
  const win = state.windows[0]
  expect(win.options.backgroundColor).toBe('#29292B')
  state.dark = false; state.theme.forEach(fn=>fn())
  expect(win.setBackgroundColor).toHaveBeenCalledWith('#FFFFFF')
  prompts.hide()
  expect(state.theme.size).toBe(0)
})
