// The keyboard half of an answer guard. A panel that takes focus can be
// shown while the person types at the page, so a page that raises a question
// as they type could have Tab, Tab, Enter land on its Allow. The guard
// therefore also waits for the keyboard to be quiet.
import type { OverlayKey } from './overlay-types.js'

/** Enter and Space activate the focused button; their own press must not refuse the click it makes. */
const ACTIVATING = new Set(['Enter', ' '])

export interface KeyQuiet {
  /** For the handler's `key`: true swallows the key. */
  readonly onKey: (key: OverlayKey) => boolean
  /** Milliseconds since the last key that moved or held anything; Infinity when there has been none. */
  readonly quietFor: () => number
  readonly reset: () => void
}

export function createKeyQuiet (now: () => number): KeyQuiet {
  let lastAt: number | null = null
  return {
    onKey: (key) => {
      const activating = ACTIVATING.has(key.key)
      // A held key repeats without the person pressing anything: it restarts the wait, and never activates.
      if (key.isAutoRepeat || !activating) lastAt = now()
      return key.isAutoRepeat && activating
    },
    quietFor: () => lastAt === null ? Infinity : now() - lastAt,
    reset: () => { lastAt = null }
  }
}
