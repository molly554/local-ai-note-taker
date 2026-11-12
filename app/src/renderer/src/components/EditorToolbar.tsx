import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu, type BubbleMenuProps } from '@tiptap/react/menus'
import { closeHistory } from '@tiptap/pm/history'
import { Bold, Heading, Italic, List, ListOrdered } from 'lucide-react'
import { dirOf, t } from '../../../shared/i18n'
import { useLanguage } from '../i18n'

export function EditorToolbar({ editor }: { editor: Editor }) {
  const lang = useLanguage()
  const menu = useRef<HTMLDivElement>(null)
  const dismissed = useRef<string | null>(null)
  // A separate portal host avoids clipping and lets the menu detect focus leaving it.
  const [host] = useState(() => document.createElement('div'))
  const [scrollTarget, setScrollTarget] = useState<HTMLElement>()
  const active = useEditorState({ editor, selector: ({ editor }) => ({
    bold: editor.isActive('bold'), italic: editor.isActive('italic'), heading: editor.isActive('heading', { level: 2 }),
    bullets: editor.isActive('bulletList'), numbers: editor.isActive('orderedList'),
  }) })
  const options = useMemo<BubbleMenuProps['options']>(() => ({
    strategy: 'fixed', placement: 'top', offset: 8, scrollTarget,
    flip: { padding: 8, boundary: scrollTarget }, shift: { padding: 8, boundary: scrollTarget },
    hide: { boundary: scrollTarget },
  }), [scrollTarget])
  const shouldShow = useCallback<NonNullable<BubbleMenuProps['shouldShow']>>(({ view, state, from, to, element }) => {
    if (dismissed.current !== `${from}:${to}`) dismissed.current = null
    return !dismissed.current && editor.isEditable && !state.selection.empty && !!state.doc.textBetween(from, to).trim()
      && (view.hasFocus() || element.contains(document.activeElement))
  }, [editor])
  const escape = useCallback(() => {
    const { from, to } = editor.state.selection
    dismissed.current = `${from}:${to}`
    editor.view.focus()
    editor.commands.setMeta('editorFormatting', 'hide')
  }, [editor])

  useEffect(() => {
    document.body.append(host)
    setScrollTarget(editor.view.dom.closest<HTMLElement>('.note-notes-pane') ?? undefined)
    const keydown = (event: KeyboardEvent) => {
      if (event.altKey && event.key === 'F10' && !editor.state.selection.empty) {
        event.preventDefault()
        dismissed.current = null
        editor.commands.setMeta('editorFormatting', 'show')
        menu.current?.querySelector<HTMLButtonElement>('button')?.focus()
      } else if (event.key === 'Escape' && menu.current?.isConnected) {
        event.preventDefault()
        event.stopPropagation()
        escape()
      }
    }
    const dom = editor.view.dom
    const selectionChanged = () => { dismissed.current = null }
    dom.addEventListener('keydown', keydown)
    editor.on('selectionUpdate', selectionChanged)
    return () => { dom.removeEventListener('keydown', keydown); editor.off('selectionUpdate', selectionChanged); host.remove() }
  }, [editor, escape, host])

  const actions = [
    { label: t('Bold'), icon: Bold, active: active.bold, shortcut: 'Meta+B', run: () => editor.chain().toggleBold().run() },
    { label: t('Italic'), icon: Italic, active: active.italic, shortcut: 'Meta+I', run: () => editor.chain().toggleItalic().run() },
    { label: t('Heading'), icon: Heading, active: active.heading, run: () => editor.chain().toggleHeading({ level: 2 }).run() },
    { label: t('Bulleted list'), icon: List, active: active.bullets, run: () => editor.chain().toggleBulletList().run() },
    { label: t('Numbered list'), icon: ListOrdered, active: active.numbers, run: () => editor.chain().toggleOrderedList().run() },
  ]
  return scrollTarget && <BubbleMenu ref={menu} editor={editor} pluginKey="editorFormatting" appendTo={host} className="editor-menu"
    updateDelay={0} resizeDelay={16} options={options} shouldShow={shouldShow}>
      <div role="toolbar" className="editor-toolbar" data-testid="editor-toolbar" aria-label={t('Text formatting')} dir={dirOf(lang)}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); escape(); return }
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const buttons = Array.from(event.currentTarget.querySelectorAll('button'))
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const step = (event.key === 'ArrowRight' ? 1 : -1) * (dirOf(lang) === 'rtl' ? -1 : 1)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + step + buttons.length) % buttons.length
          buttons[next]?.focus()
        }}
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== editor.view.dom)
            editor.commands.setMeta('editorFormatting', 'hide')
        }}>
        {actions.map(({ label, icon: Icon, active, shortcut, run }, index) => <button key={label} type="button" tabIndex={index === 0 ? 0 : -1}
          aria-label={label} title={label} aria-pressed={active} aria-keyshortcuts={shortcut}
          onClick={event => {
            editor.view.dispatch(closeHistory(editor.state.tr))
            run()
            if (event.detail > 0) editor.view.focus()
          }}>
          <Icon size={16} aria-hidden="true" />
        </button>)}
      </div>
  </BubbleMenu>
}
