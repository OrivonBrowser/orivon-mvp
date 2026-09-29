// What the chrome's own right-click menu (window.ts) offers: the same edit
// commands every page gets, plus Inspect Element where DevToolsGate.allowed()
// says developer tools may open on the chrome's own webContents.
// shell-ui-page.ts's isShellUiPage() (wired in shell-services.ts) is what
// keeps that refused outside developer mode.
import type { BaseWindow, WebContents } from 'electron'
import type { DevToolsGate } from '../devtools/devtools-service.js'
import type { ContextMenuHost } from './context-menu.js'

export function chromeContextMenuHost (
  devtools: DevToolsGate | undefined,
  chromeContents: WebContents,
  window: BaseWindow,
  openInNewTab: (url: string) => void
): ContextMenuHost {
  const canInspect = devtools?.allowed(chromeContents) === true
  return {
    window,
    openInNewTab,
    ...(canInspect ? { inspect: (x: number, y: number) => { devtools?.inspect(chromeContents, window, x, y) } } : {})
  }
}
