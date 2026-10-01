// How long ago something happened, in the few words a list has room for. Pure: the time now is passed in.
export function relativeTime (then: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - then) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${String(minutes)} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} h ago`
  return `${String(Math.floor(hours / 24))} d ago`
}
