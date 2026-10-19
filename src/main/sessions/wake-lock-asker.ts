// The per-site asker that owns `screen-wake-lock` (ADR-0090). It never asks anyone: it answers yes for a tab's top
// frame and no for everything else, which the gate's own rules would also deny, so a name owned here is never
// granted to an extension's page, a shell view, an embed or an embedded frame. Pure: no `electron` import.
import type { WebContents } from 'electron'
import type { SiteAsker } from './site-asks.js'

const PERMISSION = 'screen-wake-lock'

/** Electron states `isMainFrame` on both handlers' details for this name; anything else is not the top frame. */
function inTopFrame (details: unknown): boolean {
  return typeof details === 'object' && details !== null && (details as { isMainFrame?: unknown }).isMainFrame === true
}

export interface WakeLockAskerDeps {
  /** An ordinary tab or an app's tab, as opposed to an embed, an extension's page or a shell view. */
  readonly isTab: (contents: WebContents) => boolean
}

export function createWakeLockAsker (deps: WakeLockAskerDeps): SiteAsker {
  return {
    name: 'screen-wake-lock',
    request (contents, permission, details) {
      if (permission !== PERMISSION) return undefined
      return Promise.resolve(deps.isTab(contents) && inTopFrame(details))
    },
    check (contents, permission, _requestingOrigin, details) {
      if (permission !== PERMISSION) return undefined
      return contents !== null && deps.isTab(contents) && inTopFrame(details)
    }
  }
}
