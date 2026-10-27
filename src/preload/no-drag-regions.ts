import { webFrame } from 'electron'

// A page's `app-region: drag` is not a style the page keeps to itself: Electron's hit test answers "caption" for
// the rectangles it reports, so a real press on a button inside one is taken as a window drag and the page never
// sees it. The window's frame belongs to the shell, so no page may declare one.
//
// A user-origin sheet with `!important` outranks every author declaration, important or not, so a page that sets
// the property later, inline or from a stylesheet, still loses.

export const NO_DRAG_REGIONS_CSS = '*, *::before, *::after { -webkit-app-region: no-drag !important; app-region: no-drag !important; }'

/** Runs from the top frame, as the rest of the ordinary-tab surface does (app.ts gates it). */
export function installNoDragRegions (): void {
  webFrame.insertCSS(NO_DRAG_REGIONS_CSS, { cssOrigin: 'user' })
}
