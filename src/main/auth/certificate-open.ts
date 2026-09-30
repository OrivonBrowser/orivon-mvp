// When the certificate viewer may open, and what opens it. The host is read here from the tab's own address:
// the viewer can neither be opened by a page nor be told whose certificate to show.
import type { ShellWindow } from '../shell/window-registry.js'
import { CERTIFICATE_OVERLAY } from './auth-names.js'

/** The host of the page a tab shows, or undefined for any page that was not delivered over https. */
export function httpsHostOf (url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' ? parsed.hostname.replace(/^\[|\]$/g, '') : undefined
  } catch {
    return undefined
  }
}

/** The host of the tab in front of this window when it is an https page. */
export function activeHttpsHost (window: Pick<ShellWindow, 'tabs'>): string | undefined {
  const { tabs, activeTabId } = window.tabs.getState()
  const active = tabs.find((tab) => tab.id === activeTabId)
  return active === undefined ? undefined : httpsHostOf(active.url)
}

/** Whether `site.certificate` would do anything here; the main menu greys its row by it. */
export function certificateAvailable (window: Pick<ShellWindow, 'tabs'>): boolean {
  return activeHttpsHost(window) !== undefined
}

export function openCertificate (target: Pick<ShellWindow, 'tabs' | 'overlays'>): void {
  if (activeHttpsHost(target) === undefined) return
  target.overlays.show(CERTIFICATE_OVERLAY)
}
