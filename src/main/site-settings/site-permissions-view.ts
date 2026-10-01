// What the site-info popover shows of one site's permissions, and the two things it may do: read them and change
// one. The popover is built for ONE origin, fixed in main, so nothing here takes an origin from the page.
// No `electron` import.
import type { SiteKind } from './kinds.js'
import type { SiteKindRow, SiteSettingsController } from './site-settings-controller.js'

export interface SitePermissionsView {
  /** Every kind that can be set for this site. */
  readonly rows: readonly SiteKindRow[]
  /** The kinds listed at first: those with an answer of the site's own, and those the page asked about. */
  readonly shown: readonly SiteKind[]
  /** A private window forgets the answers when it closes. */
  readonly isPrivate: boolean
}

export interface SitePermissionsDeps {
  readonly controller: SiteSettingsController
  /** What the page in front asked or was refused, for this origin. */
  readonly requested: (origin: string) => readonly SiteKind[]
  readonly isPrivate: boolean
}

export interface SitePermissionsAccess {
  /** Null for an origin that has no per-site settings: an app, or an address that is not an ordinary website. */
  view: (origin: string) => SitePermissionsView | null
  /** Null when the change was refused (an app, a kind that is not available, a value that is not a choice): nothing changed. */
  set: (origin: string, kind: unknown, value: unknown) => SitePermissionsView | null
}

export function sitePermissions (deps: SitePermissionsDeps): SitePermissionsAccess {
  const view = (origin: string): SitePermissionsView | null => {
    const rows = deps.controller.rowsFor(origin)
    if (rows.length === 0) return null
    const requested = new Set(deps.requested(origin))
    return { rows, shown: rows.filter((row) => row.value !== 'default' || requested.has(row.kind)).map((row) => row.kind), isPrivate: deps.isPrivate }
  }
  return {
    view,
    set: (origin, kind, value) => {
      return deps.controller.set(origin, kind, value) ? view(origin) : null
    }
  }
}
