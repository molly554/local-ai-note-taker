import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Toast } from '@animate-ui/react/primitives/base-ui/toast'
import { X } from 'lucide-react'
import { t } from '../../../shared/i18n'
import type { SetupState } from '../../../shared/types'
import { notesReadyNotice } from '../notesSetup'

let toastHost: HTMLDivElement | undefined
// Keep Undo reachable when Ask uses the native modal top layer on smaller windows.
export function setToastDialog(dialog: HTMLDialogElement | null) {
  if (toastHost) (dialog ?? document.body).append(toastHost)
}

type Shown = { id: string; error?: string; /** the note it was moved from: Undo opens it again */ from?: string }
let show: ((s: Shown) => void) | undefined
export const toasts = Toast.createToastManager<{ testId?: string; actionTestId?: string }>()

/**
 * Delete in a list or a note: the meeting goes to the Trash at once, no question asked, and a toast
 * says so with Undo. from: the route it was deleted on, when that was its own note (main has already gone home).
 */
export async function moveToTrash(id: string, from?: string): Promise<boolean> {
  const r = await window.yogurt.meetings.trash(id).catch(() => 'failed' as const)
  if (r === 'trashed') { show?.({ id, from }); return true }
  if (r === 'missing') return true
  show?.({ id, error: r === 'recording' ? t('Stop the recording first, then try again.')
    : r === 'save-pending' ? t('Open this note and finish saving before deleting it.')
    : t("Yogurt couldn't move this note to the Trash. Try again.") })
  return false
}

/** "Moved to the Trash" with Undo, for a few seconds; one at a time, the newest wins */
export function TrashToast({ go }: { go: (route: string) => void }) {
  const [host] = useState(() => document.createElement('div'))
  const notice = useRef<ReturnType<typeof notesReadyNotice>>(undefined)
  notice.current ??= notesReadyNotice()
  useEffect(() => {
    let current: SetupState | undefined, active = true
    const update = (state: SetupState) => {
      current = state
      if (notice.current!(state, document.visibilityState === 'visible', Date.now())) {
        toasts.add({ title: t("Yogurt's AI is ready. Summaries and Ask now work."), data: { testId: 'notes-ready-toast' } })
      }
    }
    const off = window.yogurt.setup.onState(update)
    void window.yogurt.setup.state().then(state => { if (active && !current) update(state) })
    const visibility = () => { if (current) update(current) }
    document.addEventListener('visibilitychange', visibility)
    return () => { active = false; off(); document.removeEventListener('visibilitychange', visibility) }
  }, [])
  useLayoutEffect(() => {
    toastHost = host
    document.body.append(host)
    return () => { toastHost = undefined; host.remove() }
  }, [host])
  useEffect(() => {
    const remind = () => {
      void window.yogurt.meetings.takeRecordingReminder().then(id => {
        if (id) toasts.add({ id: `recording-reminder-${id}`, title: t("Let everyone know you're recording."), timeout: 4000, data: { testId: 'recording-reminder' } })
      })
    }
    const off = window.yogurt.meetings.onChange(remind)
    remind()
    return off
  }, [])
  const previous = useRef<string>(undefined)
  useEffect(() => {
    show = (s) => {
      if (previous.current) toasts.close(previous.current)
      let restoring = false
      const id = toasts.add({
        title: s.error ?? t('Moved to the Trash'), timeout: 8000,
        data: { testId: 'trash-toast', actionTestId: 'trash-undo' },
        actionProps: s.error ? undefined : { children: t('Undo'), onClick: async () => {
          if (restoring) return
          restoring = true
          try {
            await window.yogurt.meetings.restore(s.id)
            toasts.close(id)
            if (s.from) go(s.from)
          } catch { toasts.update(id, { title: t("Yogurt couldn't make that change. Try again."), timeout: 0 }) }
          finally { restoring = false }
        } },
      })
      previous.current = id
    }
    return () => { show = undefined }
  }, [go])
  return <Toast.Provider toastManager={toasts} timeout={6000} limit={3} progressBar={false}>
    <Toast.Portal container={host}><Toast.Viewport className="app-toast-viewport"><ToastList /></Toast.Viewport></Toast.Portal>
  </Toast.Provider>
}

function ToastList() {
  const { toasts: shown } = Toast.useToastManager<{ testId?: string; actionTestId?: string }>()
  return shown.map(item => <Toast.Root key={item.id} toast={item} className="app-toast" swipeDirection={['down', 'right']}
    data-testid={item.transitionStatus === 'ending' ? undefined : item.data?.testId ?? 'app-toast'}>
    <Toast.Content className="app-toast-content">
      <Toast.Title className="app-toast-title" />
      {item.actionProps && <Toast.Action className="app-toast-action" data-testid={item.data?.actionTestId} />}
      <Toast.Close className="app-toast-close" aria-label={t('Close')}><X size={14} aria-hidden="true" /></Toast.Close>
    </Toast.Content>
  </Toast.Root>)
}
