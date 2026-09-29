// What the chrome's own right-click menu (window.ts) offers: the same edit
// commands every page gets, plus Inspect Element where developer tools are
// allowed. DevToolsGate.allowed() alone is not enough here -- it treats a
// page as gated only when isShellPage() names it (settings, ...), and the
// chrome view is not one of those, so it would pass whenever the
// developer.tools setting is on, dev mode or not. devModeEnabled() is the
// gate that actually keeps the chrome's own privileged page out of reach
// outside dev mode.
import type { BaseWindow, WebContents } from 'electron'
import type { DevToolsGate } from '../devtools/devtools-service.js'
import type { ContextMenuHost } from './context-menu.js'

export function chromeContextMenuHost (
  devModeEnabled: () => boolean,
  devtools: DevToolsGate | undefined,
  chromeContents: WebContents,
  window: BaseWindow,
  openInNewTab: (url: string) => void
): ContextMenuHost {
  const canInspect = devModeEnabled() && devtools?.allowed(chromeContents) === true
  return {
    window,
    openInNewTab,
    ...(canInspect ? { inspect: (x: number, y: number) => { devtools?.inspect(chromeContents, window, x, y) } } : {})
  }
}
