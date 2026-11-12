import { AudioLines, Bell, CalendarDays, Mic, Users, type LucideIcon } from 'lucide-react'
import type { PermissionKind } from '../../shared/types'
import type { ScreenId } from '../../shared/onboarding'
import { t } from '../../shared/i18n'
import { osWords } from './keys'

/**
 * What each permission gives the person: reason is the explanation Settings shows. pane and where
 * say where System Settings keeps it, for the guide. The first run's own words are in screenCopy.
 */
export const permissionCopy = (k: PermissionKind): { icon: LucideIcon; name: string; reason: string; pane: string; where: string } => {
  switch (k) {
    case 'mic': return {
      icon: Mic, name: t('Microphone'), reason: t('So it can hear you and write down what you say.'),
      pane: t('Microphone'), where: t('In Microphone, find Yogurt and turn it on.'),
    }
    case 'systemAudio': return {
      icon: AudioLines, name: t('Call audio'), reason: t('So it can write down what the others say. No bot joins the call.'),
      pane: t('Screen & System Audio Recording'), where: t('In Screen & System Audio Recording, under System Audio Recording Only, turn on Yogurt.'),
    }
    case 'calendar': return {
      icon: CalendarDays, name: t('Calendar'), reason: t("So your notes get the meeting's name and who was in it."),
      pane: t('Calendars'), where: t('In Calendars, find Yogurt and turn it on.'),
    }
    case 'notifications': return {
      icon: Bell, name: t('Notifications'), reason: t('So it can offer to take notes when a call starts.'),
      pane: t('Notifications'), where: t('In Notifications, click Yogurt, then turn on Allow notifications.'),
    }
    case 'accessibility': return {
      icon: Users, name: t('Names from your calls'), reason: t('Lets Yogurt read who is talking in Zoom, Meet and Teams. Without it, the others show as Them.'),
      pane: t('Accessibility'), where: t('In Accessibility, find Yogurt and turn it on.'),
    }
  }
}

/** Always-visible explanations for Finish setup; Settings keeps the fuller explanations. */
export function finishSetupReason(k: PermissionKind): string {
  switch (k) {
    case 'mic': return t('Captures your voice.')
    case 'systemAudio': return t('Captures the other speakers.')
    case 'notifications': return t('Asks you to record when a call starts.')
    case 'accessibility': return t('Names speakers in your transcript.')
    case 'calendar': return permissionCopy(k).reason
  }
}

/** The first run's screens: a short headline and one sentence on why it matters */
export const screenCopy = (id: 'welcome' | ScreenId | 'ready'): { title: string; text: string } => {
  switch (id) {
    case 'welcome': return { title: t('Take note.'), text: osWords({ mac: t('Yogurt writes your meeting notes while you talk. No bot joins the call, and nothing leaves your Mac.'), other: t('Yogurt writes your meeting notes while you talk. No bot joins the call, and nothing leaves your computer.') }) }
    case 'record': return { title: t('Hear the whole call'), text: t("Yogurt hears you through your microphone, and everyone else through your Mac's sound.") }
    case 'calendar': return { title: t('Know every meeting'), text: t("Notes start with the meeting's name and who's invited, from the calendars already on your Mac.") }
    case 'notifications': return { title: t('Never miss a call'), text: t('When a call starts, Yogurt offers to take notes. One click and it starts recording.') }
    case 'accessibility': return { title: t('See who said what'), text: t('Yogurt reads the names Zoom, Meet and Teams show, so your transcript says who spoke instead of Them.') }
    case 'ready': return { title: t('Almost ready'), text: osWords({ mac: t('Yogurt is setting up transcription. This happens once, then it all runs on your Mac.'), other: t('Yogurt is setting up transcription. This happens once, then it all runs on your computer.') }) }
  }
}

export const finishSetupRemaining = (count: number) => t('{count} left', { count })
