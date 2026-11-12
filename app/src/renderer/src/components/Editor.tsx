import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { Mark } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { docToMd, mdToDoc } from '../../../shared/markdown'
import { citationTargetIndex } from '../../../shared/citations'
import { EditorToolbar } from './EditorToolbar'
import { inkKey, StreamingInk } from '../streamingInk'
import { useReducedMotion } from '../motion'

/** The person's own words inside the enhanced notes: shown darker. Typing next to them is not theirs-marked. */
const Mine = Mark.create({
  name: 'mine',
  inclusive: false,
  parseHTML: () => [{ tag: 'span[data-mine]' }],
  renderHTML: () => ['span', { 'data-mine': '', class: 'mine' }, 0],
})

/**
 * A small rich-text editor with Markdown in and out: headings, bullets, bold, italic, links (and <mine> spans).
 * The Markdown given is shown; what the person types comes back through onChange. Streamed text (a draft still
 * being written) is shown as it grows, with a half-written mark or tag at its end tidied away.
 */
export function Editor(p: {
  focus?: { match?: string; seq: number }
  markdown: string
  label: string
  onChange?: (md: string) => void
  onBlur?: () => void
  editable?: boolean
  streaming?: boolean
  placeholder?: string
  testId: string
  className?: string
}) {
  const inkId = useId()
  const reduced = useReducedMotion()
  const onChange = useRef(p.onChange)
  const onBlur = useRef(p.onBlur)
  onChange.current = p.onChange
  onBlur.current = p.onBlur
  /** the Markdown last shown or reported: the editor tidying its own document (a trailing paragraph) is not a change */
  const last = useRef(p.markdown)
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        code: false, codeBlock: false, blockquote: false, horizontalRule: false, strike: false, underline: false,
        // an empty paragraph added after a final list would read as an edit (a blank line in the Markdown)
        trailingNode: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      }),
      Placeholder.configure({ placeholder: p.placeholder ?? '' }),
      Mine,
      StreamingInk,
    ],
    content: mdToDoc(p.markdown, { streaming: p.streaming }),
    editable: p.editable ?? true,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: {
      // notes are in the meeting's language, not the interface's: English notes read left to right in Arabic Yogurt
      dir: 'auto', 'data-testid': p.testId, class: `note-prose outline-none ${p.className ?? ''}`, spellcheck: 'true',
      role: 'textbox', 'aria-label': p.label, 'aria-multiline': 'true', 'aria-readonly': String(p.editable === false),
    } },
    onUpdate: ({ editor }) => {
      const md = docToMd(editor.getJSON() as Parameters<typeof docToMd>[0])
      if (md === last.current) return
      last.current = md
      onChange.current?.(md)
    },
    onBlur: () => onBlur.current?.(),
  })

  // Commit external text before paint so a saved Summary never shows the previous draft for a frame.
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return
    last.current = p.markdown
    const update = editor.chain().setMeta(inkKey, { live: !!p.streaming, reduced })
    if (docToMd(editor.getJSON() as Parameters<typeof docToMd>[0]) !== p.markdown || p.streaming) {
      update.setContent(mdToDoc(p.markdown, { streaming: p.streaming }), { emitUpdate: false })
    }
    update.run()
  }, [editor, p.markdown, p.streaming, reduced])

  useEffect(() => {
    if (!editor || editor.isDestroyed || !p.focus?.match) return
    let highlight: Highlight | undefined, timer = 0
    const frame = requestAnimationFrame(() => {
      if (editor.isDestroyed) return
      const blocks = Array.from(editor.view.dom.querySelectorAll<HTMLElement>('p,h1,h2,h3'))
      const target = blocks[citationTargetIndex(blocks.map(block => block.textContent ?? ''), p.focus!.match!)]
      if (!target) return
      target.scrollIntoView({ block: 'center' })
      const range = document.createRange()
      range.selectNodeContents(target)
      highlight = new Highlight(range)
      CSS.highlights.set('citation-target', highlight)
      timer = window.setTimeout(() => CSS.highlights.delete('citation-target'), 2400)
    })
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); if (CSS.highlights.get('citation-target') === highlight) CSS.highlights.delete('citation-target') }
  }, [editor, p.focus?.seq])

  useEffect(() => { if (editor && !editor.isDestroyed) editor.setEditable(p.editable ?? true, false) }, [editor, p.editable])

  return <><div className="summary-surface" data-streaming={!!p.streaming}>
    <svg className="summary-ink-layer" aria-hidden="true">
      <defs><filter id={inkId} x="-30%" y="-80%" width="160%" height="260%" colorInterpolationFilters="sRGB">
        <feGaussianBlur stdDeviation=".9" /><feColorMatrix values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 18 -8.5" />
      </filter></defs>
      <g className="summary-wash" />
    </svg>
    <EditorContent editor={editor} />
    <i className="summary-heading-bar" aria-hidden="true" hidden />
  </div>
    {editor && p.editable !== false && !p.streaming && <EditorToolbar editor={editor} />}
  </>
}
