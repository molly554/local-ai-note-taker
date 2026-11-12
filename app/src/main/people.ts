import type { DatabaseSync } from 'node:sqlite'
import type { Person } from './store'
import { attendeeMembership, personEmail, resolvedPersonName } from '../shared/people'
type PersonRow = { display_name: string | null; seen_names: string; first_seen: number; last_seen: number }
export function rememberPeople(db: DatabaseSync, people: Person[], at = Date.now()) {
  const get = db.prepare('SELECT * FROM people WHERE email = ?')
  const put = db.prepare(`INSERT INTO people (email, display_name, seen_names, first_seen, last_seen) VALUES (?, NULL, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET seen_names = excluded.seen_names, first_seen = min(people.first_seen, excluded.first_seen), last_seen = max(people.last_seen, excluded.last_seen)`)
  for (const p of people) {
    if (!p.email?.trim()) continue
    const email = personEmail(p.email), old = get.get(email) as PersonRow | undefined
    const names = [...new Set([...(old ? JSON.parse(old.seen_names) as string[] : []), p.name].filter(Boolean))]
    put.run(email, JSON.stringify(names), at, at)
  }
}
export function resolvePeople(db: DatabaseSync, people: Person[]): Person[] {
  const get = db.prepare('SELECT * FROM people WHERE email = ?')
  return people.map(p => {
    if (!p.email?.trim()) return p
    const email = personEmail(p.email), row = get.get(email) as PersonRow | undefined
    return { email, name: resolvedPersonName(email, row?.display_name ?? null, row ? [...JSON.parse(row.seen_names), p.name] : [p.name]) }
  })
}
export function backfillPeople(db: DatabaseSync) {
  db.exec('SAVEPOINT people_backfill')
  try {
    for (const row of db.prepare('SELECT id, attendees, started_at FROM meetings ORDER BY started_at, id').all()) {
      const people = JSON.parse(String(row.attendees)) as Person[]
      rememberPeople(db, people, Number(row.started_at))
      // Convert only a matching old baseline; a real membership change must keep its existing hint.
      db.prepare('UPDATE notes SET written_with = ? WHERE meeting_id = ? AND written_with = ?')
        .run(attendeeMembership(people), String(row.id), people.map(p => p.name).join(', '))
    }
    db.exec('RELEASE people_backfill')
  } catch (e) { db.exec('ROLLBACK TO people_backfill; RELEASE people_backfill'); throw e }
}
/** Existing local overrides win; older backups still backfill from their attendee JSON. */
export function mergePeople(into: DatabaseSync, from: DatabaseSync) {
  if (!from.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'people'").get()) return
  for (const row of from.prepare('SELECT * FROM people').all()) {
    const names = JSON.parse(String(row.seen_names)) as string[]
    rememberPeople(into, (names.length ? names : [String(row.email)]).map(name => ({ name, email: String(row.email) })), Number(row.first_seen))
    into.prepare('UPDATE people SET display_name = coalesce(display_name, ?), last_seen = max(last_seen, ?) WHERE email = ?')
      .run(row.display_name, row.last_seen, personEmail(String(row.email)))
  }
}
