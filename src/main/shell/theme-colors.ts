// Colours a view needs to show BEFORE its own page has painted: a freshly
// created WebContentsView defaults to an opaque white, and is attached to
// the screen (or created) ahead of its first paint on purpose (see each
// caller's own doc), so that default white is what actually shows for
// however long the page takes to load its own CSS otherwise.
//
// Main cannot read a renderer's stylesheet -- window-frame.ts's own
// OVERLAY_*/BACKGROUND_* constants already accept that and copy the numbers
// literally, with the same reasoning newtab/style.css's own header gives for
// why a literal copy is not a Rule 3 violation here: these are design DATA,
// not logic. This file is the ONE place in main for a colour fact that MORE
// THAN ONE caller needs (the "one home per fact" half of the same rule) --
// a colour only one file needs stays a literal there, commented with the
// CSS file it copies (tab-factory.ts's internal-page pair is the example).
import { nativeTheme } from 'electron'

export interface ThemeColorPair {
  readonly light: string
  readonly dark: string
}

/** The app's own dark wash, the same in both themes -- used where the
 * shell shows before any page of its own has loaded: the intro screen's
 * backdrop (intro-view.ts) and the new-tab dashboard's pre-paint background
 * (tab-factory.ts), matching newtab/style.css's `html` background, which is
 * this same value in both themes for the same reason (a picture wash, not a
 * themed surface). */
export const APP_DARK_WASH = '#0d0e14'

/** Literally menu/style.css's own `--wbg` pair (menu-panel.ts). */
export const MENU_POPOVER_BACKGROUND: ThemeColorPair = { light: '#f2f2f7', dark: '#2b2c31' }

/** Literally permissions/style.css's and site-info/style.css's own `--wbg`
 * pair -- identical in both files on purpose (permissions-panel.ts,
 * site-info-panel.ts): both are the same toolbar-popup surface. */
export const PANEL_POPOVER_BACKGROUND: ThemeColorPair = { light: '#e5e5ec', dark: '#1e1f24' }

/** `pair.dark` under the OS/app dark theme, `pair.light` otherwise -- the one
 * ternary every caller here would otherwise repeat (window-frame.ts keeps its
 * own copy of this same shape for its `{color, symbolColor}` overlay pair,
 * which this helper does not fit). */
export function resolveThemeColor (pair: ThemeColorPair): string {
  return nativeTheme.shouldUseDarkColors ? pair.dark : pair.light
}
