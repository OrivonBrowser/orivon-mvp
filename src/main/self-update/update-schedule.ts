// When the update check runs: at start, again every hour while the browser stays open (the check itself asks the
// network at most once a day), and at once when the person switches it on. No `electron` import: the setting and the
// check come in.

/** How often a running browser asks whether a day has passed since the last check. */
export const UPDATE_POLL_MS = 60 * 60_000

export interface UpdateScheduleDeps {
  /** Whether the person lets Orivon look for updates. */
  enabled: () => boolean
  /** Calls `listener` when that setting changes; answers the removal. */
  onEnabledChange: (listener: () => void) => () => void
  /** One check; it never rejects. */
  run: () => Promise<void>
  everyMs?: number
}

/** Starts the schedule; the return stops it. A check never starts while another is still running. */
export function scheduleUpdateChecks (deps: UpdateScheduleDeps): () => void {
  let running = false
  const check = (): void => {
    if (running || !deps.enabled()) return
    running = true
    void deps.run().finally(() => { running = false })
  }
  let wasEnabled = deps.enabled()
  check()
  const timer = setInterval(check, deps.everyMs ?? UPDATE_POLL_MS)
  timer.unref?.()
  const unsubscribe = deps.onEnabledChange(() => {
    const enabled = deps.enabled()
    if (enabled && !wasEnabled) check()
    wasEnabled = enabled
  })
  return () => {
    clearInterval(timer)
    unsubscribe()
  }
}
