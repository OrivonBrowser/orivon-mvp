// The shares that are running: what the indicators list and what Stop ends. A share starts when the display handler
// answers with a source and ends when its requester's document ends, when the preload reports every track it handed
// out ended, when the tab it shows closes, or when that tab stops being captured. Main cannot see a screen or window
// capture, so only the first three apply to those. Pure over its dependencies.
import type { WebContents } from 'electron'
import type { ActiveShare, DisplayChoice, ShareRegistry } from './types.js'

/** How often a tab share is checked for having stopped being captured. */
export const CAPTURE_POLL_MS = 1000

export interface ShareRegistryDeps {
  now: () => number
  newId: () => string
  /** Calls `ended` once when `contents` loads another document, is destroyed or loses its renderer. Returns the removal. */
  watch: (contents: WebContents, ended: () => void) => () => void
  /** Whether Chromium is capturing `contents` now; false for a destroyed tab. */
  isBeingCaptured: (contents: WebContents) => boolean
  /** Tells the requester's top frame to stop the tracks it handed out for the share with this nonce. */
  sendStop: (requester: WebContents, nonce: string) => void
  markInUse: (contents: WebContents) => void
  clearInUse: (contents: WebContents) => void
  /** Runs `tick` every `ms` until the returned stop is called. */
  every: (tick: () => void, ms: number) => () => void
}

export interface ShareStart {
  readonly requester: WebContents
  readonly origin: string
  readonly choice: DisplayChoice
  /** What the page really got: it asked, and the source can carry it. */
  readonly audio: boolean
  readonly nonce: string
}

export interface ShareHost extends ShareRegistry {
  start: (input: ShareStart) => ActiveShare
  /** The preload says every track it handed out for `nonce` has ended. */
  tracksEnded: (requester: WebContents, nonce: string) => void
}

interface Entry {
  readonly share: ActiveShare
  readonly nonce: string
  /** A tab share counts as stopped only after Chromium was seen capturing it. */
  seenCaptured: boolean
  readonly unwatch: Array<() => void>
}

export function createShareRegistry (deps: ShareRegistryDeps): ShareHost {
  const entries = new Map<string, Entry>()
  const listeners = new Set<() => void>()
  let stopPolling: (() => void) | undefined

  const changed = (): void => {
    for (const listener of [...listeners]) {
      try { listener() } catch (error) { console.error('[share-registry] a listener failed:', error) }
    }
  }

  function end (id: string): void {
    const entry = entries.get(id)
    if (entry === undefined) return
    entries.delete(id)
    for (const unwatch of entry.unwatch) unwatch()
    const requester = entry.share.requester
    if (![...entries.values()].some((other) => other.share.requester === requester)) deps.clearInUse(requester)
    if (![...entries.values()].some((other) => other.share.captured !== undefined)) { stopPolling?.(); stopPolling = undefined }
    changed()
  }

  function poll (): void {
    for (const [id, entry] of [...entries]) {
      const captured = entry.share.captured
      if (captured === undefined) continue
      if (deps.isBeingCaptured(captured)) entry.seenCaptured = true
      else if (entry.seenCaptured) end(id)
    }
  }

  return {
    list: () => [...entries.values()].map((entry) => entry.share),
    forRequester: (contents) => [...entries.values()].filter((entry) => entry.share.requester === contents).map((entry) => entry.share),
    forCaptured: (contents) => [...entries.values()].filter((entry) => entry.share.captured === contents).map((entry) => entry.share),
    onChange (listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    stop (id) {
      const entry = entries.get(id)
      if (entry !== undefined) deps.sendStop(entry.share.requester, entry.nonce)
    },

    start ({ requester, origin, choice, audio, nonce }) {
      const id = deps.newId()
      const share: ActiveShare = {
        id, requester, origin, kind: choice.kind, label: choice.label, audio, startedAt: deps.now(),
        ...(choice.kind === 'tab' ? { captured: choice.tab } : {})
      }
      const entry: Entry = { share, nonce, seenCaptured: false, unwatch: [] }
      entries.set(id, entry)
      entry.unwatch.push(deps.watch(requester, () => { end(id) }))
      if (share.captured !== undefined) {
        entry.unwatch.push(deps.watch(share.captured, () => { end(id) }))
        stopPolling ??= deps.every(poll, CAPTURE_POLL_MS)
      }
      deps.markInUse(requester)
      changed()
      return share
    },

    tracksEnded (requester, nonce) {
      for (const [id, entry] of [...entries]) {
        if (entry.share.requester === requester && entry.nonce === nonce) end(id)
      }
    }
  }
}
