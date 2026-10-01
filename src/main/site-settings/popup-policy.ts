// Whether a window a page opens by itself is let through. Electron's
// `HandlerDetails` says nothing about a user gesture, so the person's own
// input to that tab stands in for it: an open soon after a click or key press
// is theirs, any other is the page's. Pure: no `electron` import.
import type { SiteDecision } from './site-settings-store.js'

/** How long after a click or key press a page may still open a window. Chromium's own transient-activation lifetime, so a sign-in popup opened after a short network call still opens. */
export const POPUP_INPUT_WINDOW_MS = 5000

export interface PopupFacts {
  /** The site's stored answer for pop-ups, or what the person chose for every site when it has none. */
  readonly value: SiteDecision
  /** When the person last clicked or pressed a key in the opener's tab, or null if they have not. */
  readonly lastInteractionAt: number | null
  readonly now: number
  /** The last input already opened a window: one open per click or key press. */
  readonly consumed: boolean
}

export type PopupVerdict = 'allow' | 'block'

/** `block` is the rule for a site with no gesture to show, not a ban: a person who clicked a link still gets the window they asked for. */
export function decidePopup (facts: PopupFacts): PopupVerdict {
  if (facts.value === 'allow') return 'allow'
  const { lastInteractionAt } = facts
  if (lastInteractionAt === null || facts.consumed) return 'block'
  const age = facts.now - lastInteractionAt
  return age >= 0 && age <= POPUP_INPUT_WINDOW_MS ? 'allow' : 'block'
}
