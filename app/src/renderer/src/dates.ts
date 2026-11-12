import { useEffect, useState } from 'react'
export { dayLabel, daysAgo, noteDateLabel, timeOf } from '../../shared/dates'

/** Today's date, which changes just after midnight (and when the Mac wakes on another day), so day names stay true */
export function useDay(): string {
  const [day, setDay] = useState(() => new Date().toDateString())
  useEffect(() => {
    const next = new Date(); next.setHours(24, 0, 1, 0)
    const timer = setTimeout(() => setDay(new Date().toDateString()), next.getTime() - Date.now())
    const check = () => setDay(new Date().toDateString())
    window.addEventListener('focus', check)
    return () => { clearTimeout(timer); window.removeEventListener('focus', check) }
  }, [day])
  return day
}
