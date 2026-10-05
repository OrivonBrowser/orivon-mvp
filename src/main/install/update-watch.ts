// The open-tab half of the update check (ADR-0056): a name can move while a page stays open, and
// no visit raises a hint for it, so every interval each origin that has a tab open is looked at
// again. Electron-free: which origins are open and what one check does come in as functions.

/** How often an origin with an open app tab is looked at. */
export const OPEN_TAB_CHECK_MS = 30 * 60_000

export interface UpdateWatchDeps {
  /** The origins with a live tab, in any window; may repeat one. */
  readonly openOrigins: () => readonly string[]
  /** One queued check of one origin; a rejection is logged and the watch goes on. */
  readonly check: (origin: string) => Promise<void>
  readonly intervalMs: number
}

/** Starts the watch; the returned function stops it. */
export function startUpdateWatch (deps: UpdateWatchDeps): () => void {
  const running = new Set<string>()
  const timer = setInterval(() => {
    for (const origin of new Set(deps.openOrigins())) {
      if (running.has(origin)) continue
      running.add(origin)
      deps.check(origin)
        .catch((error: unknown) => { console.error('[orivon] update check failed for an open tab', origin, error) })
        .finally(() => { running.delete(origin) })
    }
  }, deps.intervalMs)
  return () => { clearInterval(timer) }
}
