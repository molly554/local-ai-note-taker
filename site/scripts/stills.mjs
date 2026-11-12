// Browser-only asset export. Never imports Playwright or starts Electron.
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const origin = process.env.SITE_URL || 'http://127.0.0.1:43933'
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Export only the local fictional site.')
const chromePath = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'yogurt-site-render-'))
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
let socket, counter = 0
const errors = []
const replies = new Map(), pause = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''
    const timeout = setTimeout(() => reject(new Error('Chrome did not start in 15 seconds')), 15000)
    chrome.stderr.on('data', chunk => { log += chunk; const match = log.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timeout); resolve(match[1]) } })
    chrome.once('error', reject); chrome.once('exit', code => { clearTimeout(timeout); reject(new Error(`Chrome exited: ${code}`)) })
  })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data), pending = replies.get(message.id)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
    if (pending) { replies.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result) }
  }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++counter; replies.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const call = (method, params) => send(method, params, sessionId)
  const evaluate = async expression => {
    const result=await call('Runtime.evaluate', { expression, returnByValue: true })
    assert(!result.exceptionDetails,result.exceptionDetails?.exception?.description)
    return result.result.value
  }
  await call('Page.enable'); await call('Runtime.enable')
  const {createRequire}=await import('node:module')
  const require=createRequire(await fs.realpath(path.join(site,'node_modules/next/package.json'))),sharp=require('sharp')
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'},{name:'prefers-reduced-motion',value:'reduce'}]})
  const {beats}=await import('../renderer/timeline.mjs')
  const images={}
  const {createHash}=await import('node:crypto')
  for (const [name,width,height] of [['desktop',1000,608],['phone',600,912]]) {
    const phone=name==='phone'
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:2,mobile:false})
    for (const [beat,time] of beats) {
      if(!['arrival','answer'].includes(beat)||phone&&beat!=='answer')continue
      await call('Page.navigate',{url:origin+`/marketing/app/frame.html?still=${time}`})
      await pause(1000)
      const info=await evaluate(`({ready:document.documentElement.dataset.ready,text:document.body.innerText,overflow:document.documentElement.scrollWidth>innerWidth,bg:getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),loader:!!document.querySelector('.bubble .live-dots'),names:[...document.querySelectorAll('[data-testid="transcript-who"]')].map(e=>e.textContent),selected:document.querySelector('[role=tab][aria-selected=true]')?.textContent,questionSent:document.documentElement.dataset.questionSent,panelHeight:document.querySelector('[data-testid=chat-panel]')?.getBoundingClientRect().height,level:document.querySelector('[data-testid=note-wave]')?.dataset.level})`)
      console.log(name,beat,JSON.stringify(info))
      assert.deepEqual(errors,[],'the generated frame has no runtime errors')
      assert.equal(info.ready,'true','real renderer fixture is ready')
      assert(!info.text.includes('Planned'));assert(!info.overflow)
      assert.equal(info.bg.toLowerCase(),'#1b1b1d','only the frame is forced to app dark')
      assert(!info.text.includes('Let the others'),'no recording reminder in the demonstration')
      if (beat==='arrival') assert.equal(new Set(info.names).size,1)
      if(beat==='arrival')assert(info.level!==undefined,'native recording indicator is mounted in its reduced-motion still')
      if(beat==='answer') {
        const fits=await evaluate(`(()=>{const h=document.querySelector('.chat-history'),r=h.getBoundingClientRect();return h.scrollHeight<=h.clientHeight+1&&['chat-question','chat-answer','source-citation'].every(id=>{const a=document.querySelector('[data-testid='+id+']').getBoundingClientRect();return a.top>=r.top&&a.bottom<=r.bottom})})()`)
        assert(fits,'question, complete answer and citation must fit with no thread scroll')
      }
      const png=Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64')
      const files=[]
      if (beat==='arrival'&&!phone) files.push('hero-desktop.webp')
      if (beat==='answer') files.push(phone?'hero-phone.webp':'hero-finished-desktop.webp')
      for (const file of files) {
        const bytes=await sharp(png).webp({quality:90}).toBuffer()
        await fs.writeFile(path.join(site,'public/marketing/stills',file),bytes)
        images[file]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
      }
    }
  }
  await call('Emulation.setDefaultBackgroundColorOverride',{color:{r:0,g:0,b:0,a:0}})
  for (const kind of ['transcript','summary','ask']) {
    for (const [device,width] of [['desktop',354],['phone',320]]) {
      const height=device==='phone'?280:304
      await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:2,mobile:false})
      await call('Page.navigate',{url:origin+`/marketing/app/frame.html?fragment=${kind}&still=99`})
      await pause(900)
      assert.deepEqual(errors,[],'fragment components have no runtime errors')
      const info=await evaluate(`(()=>{const e=document.querySelector('.marketing-fragment'),r=e.getBoundingClientRect();return {ready:document.documentElement.dataset.ready,text:e.innerText,top:r.top,bottom:r.bottom,bg:getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()}})()`)
      console.log(kind,device,JSON.stringify(info))
      assert.equal(info.ready,'true');assert(info.top>=0&&info.bottom<=height,'fragment must fit at the app type size')
      assert.notEqual(info.bg.toLowerCase(),'#1b1b1d','fragments stay light')
      if(kind==='ask')assert.equal(await evaluate("document.querySelectorAll('[data-testid=source-citation]').length"),1)
      const file=`fragment-${kind}-${device}.webp`
      const png=Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'),bytes=await sharp(png).webp({quality:90}).toBuffer()
      await fs.writeFile(path.join(site,'public/marketing/stills',file),bytes)
      images[file]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
    }
  }
  const manifest=JSON.parse(await fs.readFile(path.join(site,'public/marketing/app/manifest.json'),'utf8'))
  await fs.writeFile(path.join(site,'public/marketing/stills/manifest.json'),JSON.stringify({appCommit:manifest.appCommit,bundleSha256:manifest.files['renderer.js'].sha256,generatedAt:new Date().toISOString(),images},null,2)+'\n')

} finally {
  socket?.close(); chrome.kill()
  await pause(300)
  await fs.rm(profile, {recursive:true,force:true})
}
