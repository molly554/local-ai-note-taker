import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { cubicBezier } from 'motion'
import { InkArrival } from '../../shared/inkArrival'

export const inkKey = new PluginKey<{ live: boolean; reduced: boolean; decorations: DecorationSet }>('streamingInk')
const clamp = (n: number) => Math.max(0, Math.min(1, n))
const pull = cubicBezier(.18, .8, .25, 1)

export const StreamingInk = Extension.create({
  name: 'streamingInk',
  addProseMirrorPlugins() {
    const arrivals = new InkArrival()
    return [new Plugin({
      key: inkKey,
      state: {
        init: () => ({ live: false, reduced: false, decorations: DecorationSet.empty }),
        apply(tr, previous) {
          const mode = tr.getMeta(inkKey) ?? previous
          if (!mode.live) {
            arrivals.update('', 0)
            return { ...mode, decorations: DecorationSet.empty }
          }
          if (!tr.docChanged && mode.live === previous.live && mode.reduced === previous.reduced) return previous
          let text = ''
          const pieces: { from: number; to: number; pos: number }[] = []
          tr.doc.descendants((node, pos) => {
            if (node.isTextblock) text += '\n'
            if (node.isText) {
              pieces.push({ from: text.length, to: text.length + node.text!.length, pos })
              text += node.text
            }
          })
          const now = performance.now(), decorations: Decoration[] = []
          let piece = 0
          for (const word of arrivals.update(text, now)) {
            while (piece < pieces.length && pieces[piece].to <= word.from) piece++
            if (mode.reduced || now - word.born >= 420) continue
            for (let i = piece; i < pieces.length && pieces[i].from < word.to; i++) {
              const p = pieces[i]
              decorations.push(Decoration.inline(p.pos + Math.max(0, word.from - p.from), p.pos + Math.min(p.to, word.to) - p.from,
                { class: 'summary-ink', 'data-ink-born': String(word.born) }))
            }
          }
          return { ...mode, decorations: DecorationSet.create(tr.doc, decorations) }
        },
      },
      props: { decorations: state => inkKey.getState(state)!.decorations },
      view(view) {
        let frame = 0, first: number | undefined, headingWidth = 142
        const draw = (now: number) => {
          cancelAnimationFrame(frame)
          const surface = view.dom.closest<HTMLElement>('.summary-surface')
          if (!surface) return
          const layer = surface.querySelector<SVGGElement>('.summary-wash')!
          const bar = surface.querySelector<HTMLElement>('.summary-heading-bar')!
          const { live, reduced } = inkKey.getState(view.state)!
          const waiting = live && !view.state.doc.textContent.trim()
          surface.dataset.waiting = String(waiting)
          layer.replaceChildren()
          if (!live || waiting) first = undefined
          if (live && !waiting && first === undefined) first = now
          if (live && !waiting && now - first! < 260) {
            const heading = view.dom.querySelector('h1,h2,h3')
            if (heading) {
              const range = document.createRange()
              range.selectNodeContents(heading)
              headingWidth = range.getBoundingClientRect().width
            } else headingWidth = 142
          }
          const progress = waiting ? 0 : !live || reduced ? 1 : clamp((now - (first ?? now)) / 260)
          const ease = 1 - (1 - progress) ** 3
          view.dom.style.opacity = String(waiting || !live || reduced ? 1 : ease)
          bar.hidden = !live || (!waiting && progress === 1)
          bar.style.width = `${142 + (headingWidth - 142) * pull(progress)}px`
          bar.style.transform = `scaleY(${1 - .72 * pull(progress)})`
          bar.style.opacity = String(waiting ? 1 : 1 - ease)
          let active = live && !waiting && progress < 1
          if (live && !reduced) {
            const origin = surface.getBoundingClientRect()
            const filter = surface.querySelector('filter')!.id
            for (const word of view.dom.querySelectorAll<HTMLElement>('[data-ink-born]')) {
              const age = now - Number(word.dataset.inkBorn)
              word.style.setProperty('--ink-fresh', `${(1 - clamp(age / 420)) * 100}%`)
              if (age >= 420) continue
              active = true
              // Only the wash is filtered; ranges follow wrapping text without changing its layout.
              const range = document.createRange()
              range.selectNodeContents(word)
              for (const box of range.getClientRects()) {
                const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
                const width = box.width + 4, scale = pull(clamp(age / 260))
                g.setAttribute('transform', `translate(${box.left - origin.left - 2 + width * .12 * (1 - scale)} ${box.top - origin.top}) scale(${scale} 1)`)
                g.setAttribute('opacity', String(.11 * (1 - clamp((age - 160) / 260)) * ease))
                g.setAttribute('filter', `url(#${filter})`)
                g.innerHTML = `<rect y="6" width="${width * .82}" height="12" rx="8"/><circle cx="${width - 4}" cy="12" r="4"/>`
                layer.append(g)
              }
            }
          }
          if (active) frame = requestAnimationFrame(draw)
        }
        return {
          update: () => draw(performance.now()),
          destroy: () => cancelAnimationFrame(frame),
        }
      },
    })]
  },
})
