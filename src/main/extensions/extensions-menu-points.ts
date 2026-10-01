// Where a feature adds to the Extensions menu without editing its overlay:
// a line for each row (`EXTENSION_MENU_ROW_PARTS`) and a request the page may
// make (`EXTENSION_MENU_REQUESTS`). The page's own side is `MORE_ITEMS` in
// src/renderer/overlay/extensions-menu/more-items.ts.
import type { OverlayWindow } from '../overlays/overlay-types.js'
import type { ExtensionPrefsStore } from './extension-prefs.js'
import type { MenuPayload } from './extensions-menu-model.js'

export interface MenuRowContext {
  readonly prefs: ExtensionPrefsStore
  readonly win: OverlayWindow
}

/** One per line, alphabetical by the file that adds it. The entry returns the fields its line needs, merged into `row.parts`. */
export const EXTENSION_MENU_ROW_PARTS: ReadonlyArray<(id: string, ctx: MenuRowContext) => Record<string, unknown>> = []

export interface MenuRequestContext extends MenuRowContext {
  /** `body.id` when it names an enabled extension, else undefined: an entry that needs an extension returns early without it. */
  readonly extensionId: (body: Readonly<Record<string, unknown>>) => string | undefined
  /** The menu as it is now, for a reply that redraws it. */
  readonly payload: () => Promise<MenuPayload>
  readonly close: () => void
}

/** Keyed by the request's `type`, one per line, alphabetical. A request is data from a page: validate its payload and its id. */
export const EXTENSION_MENU_REQUESTS: Readonly<Record<string, (body: Readonly<Record<string, unknown>>, ctx: MenuRequestContext) => unknown>> = {}
