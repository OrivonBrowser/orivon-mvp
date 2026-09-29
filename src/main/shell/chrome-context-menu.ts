// What the chrome's own right-click menu (window.ts) offers: the same edit
// commands every page gets, plus Inspect Element where developer tools are
// allowed. DevToolsGate.allowed() already refuses the chrome's own webContents
// outside dev mode (shell-ui-page.ts's isShellUiPage(), wired in
// shell-services.ts, names every view in the shell's own session, not only a
// registered internal page). devModeEnabled() here is a second, cheaper gate
// in front of it -- one privileged view's own check, kept in case the two
// are ever wired apart again.
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
