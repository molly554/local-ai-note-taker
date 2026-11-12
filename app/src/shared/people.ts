import type { Person } from './types'
export const personEmail = (email: string) => email.trim().toLowerCase()
export const attendeePrivacy = (focused: boolean, text: string) => focused || text.includes('@')
export const attendeeMembership = (people: Person[]) => 'members:' + JSON.stringify(people.map(p => p.email ? `email:${personEmail(p.email)}` : `name:${p.name}`).sort())
export function emailName(email: string): string {
  const local = email.split('@')[0], name = local.replace(/[._-]+/g, ' ').trim() || local
  return name.charAt(0).toUpperCase() + name.slice(1)
}
export function resolvedPersonName(email: string, display: string | null, seen: string[]): string {
  if (display) return display
  const fallback = emailName(email)
  const names = seen.filter(n => n.trim() && !n.includes('@') && n.toLowerCase() !== fallback.toLowerCase())
  // Prefer full names, then a longer name; ties keep the first observation.
  names.sort((a, b) => b.trim().split(/\s+/).length - a.trim().split(/\s+/).length || b.length - a.length)
  return names[0] || fallback
}
