// Selecting the Console panel of developer tools that are open or opening.
// Electron's `openDevTools` takes no panel, and the frontend ignores a panel
// asked for before it has built its own views, so the request is repeated
// until the panel reports itself selected. `isDevToolsOpened()` is false for a moment after `openDevTools`, so
// only the tools' own page decides when to ask.
import type { WebContents } from 'electron'

/** Runs in the tools' own page: asks for the panel, then whether its tab is the selected one. The tabs sit in
 * shadow roots, so the lookup walks them. */
const SHOW_CONSOLE = `(() => {
  if (typeof DevToolsAPI !== 'object' || DevToolsAPI === null) return false
  DevToolsAPI.showPanel('console')
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.getAttribute('role') === 'tab' && el.getAttribute('aria-selected') === 'true' && el.id === 'tab-console') return true
      if (el.shadowRoot && walk(el.shadowRoot)) return true
    }
    return false
  }
  return walk(document)
})()`

const RETRY_MS = 150
const MAX_TRIES = 40

/** Keeps asking until the panel is selected, then stops; a frontend that never reports it is left alone after six seconds. */
export function showConsolePanel (contents: WebContents): void {
  let tries = 0
  const again = (): void => {
    tries += 1
    if (tries < MAX_TRIES) setTimeout(attempt, RETRY_MS)
  }
  const attempt = (): void => {
    if (contents.isDestroyed()) return
    const tools = contents.devToolsWebContents
    if (tools === null || tools.isDestroyed() || tools.isLoading()) {
      again()
      return
    }
    void tools.executeJavaScript(SHOW_CONSOLE).then((selected) => { if (selected !== true) again() }, again)
  }
  attempt()
}
