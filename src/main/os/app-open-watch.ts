// Tells a listener (the default-browser ask) that an app has opened: a page of a
// registered app finished loading in a tab. The decision is the page's address and the app test the installer passes in; Electron is only the event it listens to.
import type { WebContents } from 'electron'

type Watched = Pick<WebContents, 'on' | 'getURL' | 'isDestroyed'>

/** Per page, the `opened` callbacks already attached: a page handed over twice reports to each once, and two listeners each hear it. */
const watched = new WeakMap<object, Set<() => void>>()

/**
 * An app's tab that finished loading a real page: an empty page is the shell clearing a tab, not an app opening.
 * `isAppTab` says whether the tab holds a registered app (the app-tab flag) now, not an ordinary website.
 */
export function watchAppOpen (contents: Watched, isAppTab: () => boolean, opened: () => void): void {
  const listeners = watched.get(contents) ?? new Set<() => void>()
  if (listeners.has(opened)) return
  listeners.add(opened)
  watched.set(contents, listeners)
  contents.on('did-finish-load', () => {
    if (contents.isDestroyed()) return
    const url = contents.getURL()
    if (url === '' || url === 'about:blank') return
    if (isAppTab()) opened()
  })
}
