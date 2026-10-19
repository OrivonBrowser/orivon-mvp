// `powerSaveBlocker` on `navigator.wakeLock`. See README.md's Design notes for the mapping and for what `isStarted` means.

import { refuse } from './errors.js'

export type PowerSaveBlockerType = 'prevent-app-suspension' | 'prevent-display-sleep'

export interface ElectronPowerSaveBlocker {
  start(type: PowerSaveBlockerType): number
  stop(id: number): boolean
  isStarted(id: number): boolean
}

interface WakeLockSentinelLike extends EventTarget { release: () => Promise<void> }

export interface PowerSaveBlockerDeps {
  readonly navigator: { readonly wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } }
  readonly document: EventTarget & { readonly visibilityState: string }
  readonly warn: (message: string, error?: unknown) => void
}

const TYPES: ReadonlySet<string> = new Set(['prevent-app-suspension', 'prevent-display-sleep'])

export function createPowerSaveBlocker (deps: PowerSaveBlockerDeps): ElectronPowerSaveBlocker {
  const started = new Set<number>()
  let nextId = 1
  let held: WakeLockSentinelLike | undefined
  let requesting = false

  /** Takes the lock when an id is started, the page is visible and nothing is held or pending. */
  function acquire (): void {
    if (started.size === 0 || held !== undefined || requesting || deps.document.visibilityState !== 'visible') return
    const wakeLock = deps.navigator.wakeLock
    if (wakeLock === undefined) {
      deps.warn('powerSaveBlocker.start: this page has no navigator.wakeLock, so nothing keeps the screen on.')
      return
    }
    requesting = true
    let pending: Promise<WakeLockSentinelLike>
    try {
      pending = wakeLock.request('screen')
    } catch (error) {
      requesting = false
      deps.warn('powerSaveBlocker.start: the wake lock request failed.', error)
      return
    }
    pending.then((sentinel) => {
      requesting = false
      if (started.size === 0) {
        void sentinel.release().catch(() => {})
        return
      }
      held = sentinel
      sentinel.addEventListener('release', () => { if (held === sentinel) held = undefined })
    }, (error: unknown) => {
      requesting = false
      deps.warn('powerSaveBlocker.start: the browser refused the wake lock; the app runs without it.', error)
    })
  }

  function releaseIfIdle (): void {
    if (started.size > 0 || held === undefined) return
    const sentinel = held
    held = undefined
    void sentinel.release().catch(() => {})
  }

  deps.document.addEventListener('visibilitychange', acquire)

  return {
    start (type) {
      if (!TYPES.has(type)) {
        throw refuse('powerSaveBlocker.start', 'invalid-usage',
          `powerSaveBlocker.start needs 'prevent-app-suspension' or 'prevent-display-sleep', got ${JSON.stringify(type)}.`)
      }
      const id = nextId++
      started.add(id)
      acquire()
      return id
    },
    stop (id) {
      const had = started.delete(id)
      releaseIfIdle()
      return had
    },
    isStarted: (id) => started.has(id)
  }
}
