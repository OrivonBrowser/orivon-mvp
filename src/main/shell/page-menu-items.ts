// Items a feature adds to a tab's right-click menu, built for the click that opened it. The extension
// host registers the one source: the shell holds no import of it.
import type { ContextMenuParams, MenuItem, WebContents } from 'electron'

export type PageMenuItemsSource = (contents: WebContents, params: ContextMenuParams) => readonly MenuItem[]

let source: PageMenuItemsSource | undefined

export function setPageMenuItemsSource (next: PageMenuItemsSource): void {
  source = next
}

/** What the source offers for a click in `contents`, nothing before one is set or when it throws. */
export function pageMenuItems (contents: WebContents, params: ContextMenuParams): readonly MenuItem[] {
  try {
    return source?.(contents, params) ?? []
  } catch (error) {
    console.error('[shell] the page menu items failed:', error)
    return []
  }
}
