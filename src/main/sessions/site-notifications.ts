// When a site may show notifications. Only the person decides: a page's
// Notification.requestPermission() reaches the REQUEST handler, which asks
// them the first time and remembers "allow" or "block" per origin. The CHECK
// handler answers Notification.permission, the Permissions API and each
// notification the page tries to show, from that remembered answer alone.
import { originFromUrl } from '../../broker/policy/origin.js'
import type { NotificationDecision } from './notification-decisions.js'
import { tabPromptState, type PromptingTab } from './tab-prompts.js'

/** "dismiss" is closing the question without choosing: no decision. */
export type NotificationAnswer = NotificationDecision | 'dismiss'

export interface SiteNotificationDeps<W> {
  decisions: {
    get: (origin: string) => NotificationDecision | undefined
    set: (origin: string, decision: NotificationDecision) => void
  }
  /** The window the tab is on screen in, or undefined for a background tab. */
  windowShowing: (tab: PromptingTab) => W | undefined
  ask: (window: W, origin: string) => Promise<NotificationAnswer>
}

export interface SiteNotifications {
  request: (tab: PromptingTab & { getURL: () => string }, details: { requestingUrl?: string | undefined, isMainFrame?: boolean | undefined }) => Promise<boolean>
  check: (requestingOrigin: string, embeddingOrigin: string | undefined) => boolean
}

export function createSiteNotifications<W> (deps: SiteNotificationDeps<W>): SiteNotifications {
  const allowed = (origin: string | null): boolean => origin !== null && deps.decisions.get(origin) === 'allow'

  return {
    async request (tab, details) {
      const origin = originFromUrl(details.requestingUrl ?? '')
      if (origin === null) return false
      // A frame never asks: the question names the page's own site, and a
      // frame from anywhere else would borrow it.
      if (details.isMainFrame !== true) return origin === originFromUrl(tab.getURL()) && allowed(origin)

      const decided = deps.decisions.get(origin)
      if (decided !== undefined) return decided === 'allow'

      const state = tabPromptState(tab)
      if (state.prompting || state.notificationsDismissed) return false
      const window = deps.windowShowing(tab)
      if (window === undefined) return false

      state.prompting = true
      let answer: NotificationAnswer
      try {
        answer = await deps.ask(window, origin)
      } catch {
        answer = 'dismiss'
      } finally {
        state.prompting = false
      }
      if (answer === 'dismiss') {
        state.notificationsDismissed = true
        return false
      }
      deps.decisions.set(origin, answer)
      return answer === 'allow'
    },

    check (requestingOrigin, embeddingOrigin) {
      const origin = originFromUrl(requestingOrigin)
      if (embeddingOrigin !== undefined && originFromUrl(embeddingOrigin) !== origin) return false
      return allowed(origin)
    }
  }
}
