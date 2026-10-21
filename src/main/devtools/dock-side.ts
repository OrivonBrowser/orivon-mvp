// Docking developer tools beside the page. Electron undocks tools asked to dock on the right of a page whose window
// draws its own title bar controls (`titleBarOverlay`, which the shell's window uses), so "Beside the page" would
// open them in a window of their own. Docked on the left Electron leaves them, so they open there and the frontend
// moves them to the right once it has started; if it never answers they stay beside the page, on the left.
import type { WebContents } from 'electron'

export type DockSetting = 'right' | 'bottom' | 'undocked'

/** The mode `openDevTools` is given for the setting: beside the page starts on the left (see the header). */
export function openingMode (dock: DockSetting): 'left' | 'bottom' | 'undocked' {
  return dock === 'right' ? 'left' : dock
}

/** Runs in the tools' own page: answers the side they were on, and moves them to the right if it was the left. */
const TO_RIGHT = `(async () => {
  if (typeof DevToolsAPI !== 'object' || DevToolsAPI === null) return null
  const { DockController } = await import('./ui/legacy/legacy.js')
  const dock = DockController.DockController.instance()
  const was = dock.dockSide()
  if (was === 'left') dock.setDockSide('right')
  return was
})()`

const RETRY_MS = 100
const MAX_TRIES = 60
/** On the right this many answers in a row after the move: Electron's own start-up has nothing left to put back. */
const SETTLED = 5

/** Moves tools opened on the left to the right. Electron applies the side it was asked for once the frontend has
 * loaded, so the frontend is asked until it has reported the left once and the right after it, settled. */
export function moveToRight (contents: WebContents): void {
  let tries = 0
  let sawLeft = false
  let onRight = 0
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
    void tools.executeJavaScript(TO_RIGHT).then((was: unknown) => {
      if (was === 'left') sawLeft = true
      onRight = sawLeft && was === 'right' ? onRight + 1 : 0
      if (onRight < SETTLED) again()
    }, again)
  }
  attempt()
}
