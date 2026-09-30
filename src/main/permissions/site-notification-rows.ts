// The site-notification list on the permissions panel: one row per site
// that answered, and the controller the panel's IPC reads. A Chromium
// permission, not an `orivon.*` grant, so it never touches the broker and
// lives apart from `permissions.ts`'s grant rows.
import type { NotificationDecision } from '../sessions/notification-decisions.js'

/**
 * One site's remembered answer to "may this site show notifications?". A
 * Chromium permission, not an `orivon.*` grant, so it is its own list, one
 * row per site, app or not. Resetting forgets the answer: the site asks
 * again next time, rather than being blocked.
 */
export interface SiteNotificationRow {
  readonly origin: string
  readonly allowed: boolean
  readonly message: string
}

/** The store `../sessions/notification-decisions.ts` keeps, as this list reads it. */
export interface SiteNotificationSource {
  entries: () => ReadonlyArray<{ origin: string, decision: NotificationDecision }>
  forget: (origin: string) => void
}

export function describeSiteNotifications (entries: ReadonlyArray<{ origin: string, decision: NotificationDecision }>): SiteNotificationRow[] {
  return [...entries]
    .sort((a, b) => a.origin.localeCompare(b.origin))
    .map(({ origin, decision }) => decision === 'allow'
      ? { origin, allowed: true, message: 'Can show notifications.' }
      : { origin, allowed: false, message: 'Blocked from showing notifications.' })
}

/** What the permissions panel calls for the site list, over IPC. Kept apart
 * from `PermissionsController`: these rows never touch the broker. */
export interface SiteNotificationsController {
  list: () => readonly SiteNotificationRow[]
  /** Forgets one site's answer; it is asked again on its next request. */
  reset: (origin: string) => void
}

export function createSiteNotificationsController (sites: SiteNotificationSource): SiteNotificationsController {
  return {
    list: () => describeSiteNotifications(sites.entries()),
    reset: (origin) => { sites.forget(origin) }
  }
}
