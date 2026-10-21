// The cover over an app's tabs while an update the person took is fetched and installed (app-updates.ts asks for it
// the moment the person says yes). The tabs' screens are the first-visit machinery's (../app-setup/tab-screens.ts); this
// file decides which tabs get one and what happens to the rest. It needs only WebContents' events, so it is
// tested with fakes; app-install-subsystem.ts gives it the real tabs.
import type { WebContents } from 'electron'
import type { TabScreens } from '../app-setup/tab-screens.js'
import type { UpdateCover, UpdateOffer } from './app-updates.js'

export interface UpdateCoverDeps {
  /** Every live tab, in any window, whose page is on `origin`. */
  readonly tabsOn: (origin: string) => readonly WebContents[]
  /** The screens for one tab showing `address`, or undefined for contents no window holds as a tab. */
  readonly screensFor: (contents: WebContents, address: string) => TabScreens | undefined
}

/** Covers each open tab of the origin now; the returned cover is settled by its first `end` or `reloadThenEnd`. */
export function createUpdateCover (deps: UpdateCoverDeps): (origin: string, offer: UpdateOffer) => UpdateCover {
  return (origin, offer) => {
    const covered = new Map<WebContents, TabScreens>()
    for (const tab of deps.tabsOn(origin)) {
      if (tab.isDestroyed()) continue
      const screens = deps.screensFor(tab, tab.getURL())
      if (screens === undefined) continue
      screens.cover({ kind: 'updating', name: offer.claimedName, fromVersion: offer.fromVersion, toVersion: offer.toVersion })
      covered.set(tab, screens)
    }
    let settled = false
    return {
      end: () => {
        if (settled) return
        settled = true
        for (const screens of covered.values()) screens.end()
      },
      reloadThenEnd: () => {
        if (settled) return
        settled = true
        // Read again: a tab opened while the update ran runs the old version too, and reloads without a cover.
        for (const tab of deps.tabsOn(origin)) {
          if (tab.isDestroyed()) continue
          const screens = covered.get(tab)
          if (screens === undefined || screens.moved()) tab.reloadIgnoringCache()
          else screens.reloadFresh()
        }
        // A tab that left the origin lost its cover when it navigated, and one that closed ended with its contents.
      }
    }
  }
}
