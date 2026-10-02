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
// CSS file it copies.
import { nativeTheme } from 'electron'

export interface ThemeColorPair {
  readonly light: string
  readonly dark: string
}

/** The app's own dark wash, the same in both themes -- the intro screen's
 * backdrop (intro-view.ts), matching intro/style.css's page background. */
export const APP_DARK_WASH = '#0d0e14'

/** What the new-tab dashboard shows before its page has painted, the same in
 * both themes: the mean colour of its picture under its dark wash, so the
 * jump to the picture is small where a near-black base read as a black flash.
 * Literally the base colour under the picture in newtab/style.css's `html`
 * background, which is what the page paints once it is up. */
export const DASHBOARD_BACKGROUND = '#394244'

/** Electron's own default: what a WebContentsView paints before anything
 * ever calls `setBackgroundColor` on it. Named so putting a view back reads as
 * returning it to this, not to an arbitrary white. */
export const DEFAULT_BACKGROUND = '#FFFFFF'

/** Literally pages/shared/tokens.css's own `--wbg` pair (Settings, History, Extensions, ...): an internal page's first paint, and what a crashed page shows behind the sad-tab card. */
export const INTERNAL_PAGE_BACKGROUND: ThemeColorPair = { light: '#f4f4f8', dark: '#17181c' }

/** Literally the `--wbg` pair of `body[data-surface='menu']` in renderer/overlay/surface.css. */
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

const themeUpdateListeners = new Set<() => void>()
/** Whether the one real `nativeTheme.on('updated', ...)` below has ever been
 * installed -- installed once per process and never removed, whatever the
 * registry's own membership does afterward (see `onThemeUpdated`'s own doc). */
let realListenerInstalled = false

/**
 * Registers `listener` to run on every live OS/app theme change, and returns
 * its unregister. Every window (its own background, window.ts) and every
 * `warm` popover (its own background, popover-view.ts) needs to hear this --
 * a direct `nativeTheme.on('updated', ...)` per caller would not do, since
 * `nativeTheme` is one process-wide `EventEmitter`: by the 11th such listener
 * (past Node's default max of 10, a handful of ordinary windows and
 * popovers) `MaxListenersExceededWarning [NativeTheme]` starts printing,
 * burying a real leak warning under a false one built into normal use.
 *
 * Backed by exactly ONE real listener for the whole process, installed the
 * first time anything registers here and never removed: window/popover
 * churn only ever adds to or removes from the `Set` below, which is what
 * keeps the real count at one regardless of how many windows open and close
 * over the app's life.
 */
export function onThemeUpdated (listener: () => void): () => void {
  if (!realListenerInstalled) {
    realListenerInstalled = true
    nativeTheme.on('updated', () => { for (const fn of [...themeUpdateListeners]) fn() })
  }
  themeUpdateListeners.add(listener)
  return () => { themeUpdateListeners.delete(listener) }
}
