import { useEffect, useState } from 'react'
import type { Folder } from '../../shared/types'

/** what a dragged meeting row carries: its id, under a type only Yogurt's own rows use */
export const MEETING_DRAG = 'application/x-yogurt-meeting'

/**
 * Folders as main has them, read again on every change to a folder and every change to meetings (a meeting deleted or
 * imported changes the counts). meetingId: only the folders that meeting is in.
 */
export function useFolders(meetingId?: string): Folder[] | undefined {
  const [folders, setFolders] = useState<Folder[]>()
  useEffect(() => {
    let seq = 0
    const load = () => {
      const mine = ++seq
      void (meetingId ? window.yogurt.folders.of(meetingId) : window.yogurt.folders.list()).then((list) => { if (mine === seq) setFolders(list) }, () => {})
    }
    load()
    const offFolders = window.yogurt.folders.onChange(load)
    const offMeetings = window.yogurt.meetings.onChange(load)
    return () => { seq++; offFolders(); offMeetings() }
  }, [meetingId])
  return folders
}
