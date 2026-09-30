// Turns a burst of pushed events into at most one call every `ms`: the first
// event in a quiet period schedules `run`, and every other event that
// arrives before it fires is a no-op. A history import or a bulk revoke that
// fires a hundred change events this way costs one refetch, not a hundred.
export function coalesce (run: () => void, ms = 1000): () => void {
  let pending: ReturnType<typeof setTimeout> | undefined
  return () => {
    if (pending !== undefined) return
    pending = setTimeout(() => { pending = undefined; run() }, ms)
  }
}
