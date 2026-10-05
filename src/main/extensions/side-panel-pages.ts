// Which window each extension side panel page belongs to. A leaf, so the places that ask which window a page
// of an extension acts in (the popup policy, the API context, the page recovery) need not import the runner.
import type { BaseWindow, WebContents } from 'electron'

const windows = new WeakMap<WebContents, BaseWindow>()
const live = new Set<WebContents>()

/** Called by the runner when it makes the panel page for `window`. */
export function registerSidePanelPage (contents: WebContents, window: BaseWindow): void {
  windows.set(contents, window)
  live.add(contents)
  contents.once('destroyed', () => { live.delete(contents) })
}

/** The side panel pages that exist now, with their windows. */
export function sidePanelPages (): ReadonlyArray<{ readonly contents: WebContents, readonly window: BaseWindow }> {
  return [...live].flatMap((contents) => {
    const window = windows.get(contents)
    return contents.isDestroyed() || window === undefined ? [] : [{ contents, window }]
  })
}

/** The shell window whose side panel `contents` is, or undefined for any other page. */
export function sidePanelWindowOf (contents: WebContents): BaseWindow | undefined {
  return windows.get(contents)
}
