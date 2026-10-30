// The one LinkStatus of each window, made when a link is first pointed at and never before: a window nobody points
// a link in carries no bubble, no view and no renderer. Its ports are the window's overlay host.
import type { ShellWindow } from '../shell/window-registry.js'
import { LinkStatus } from './link-status.js'
import type { LinkStatusPorts } from './link-status.js'
import { LINK_STATUS_OVERLAY } from './link-status-view.js'

const statuses = new WeakMap<ShellWindow, LinkStatus>()

function portsFor (window: ShellWindow): LinkStatusPorts {
  const alive = (): boolean => !window.window.isDestroyed()
  return {
    show: (bounds, view) => { if (alive()) window.overlays.show(LINK_STATUS_OVERLAY, bounds, view) },
    place: (bounds) => { if (alive()) window.overlays.reanchor(LINK_STATUS_OVERLAY, bounds) },
    send: (view) => { if (alive()) window.overlays.send(LINK_STATUS_OVERLAY, view) },
    hide: () => { if (alive()) window.overlays.close(LINK_STATUS_OVERLAY) },
    window: () => alive() ? window.window.getContentBounds() : undefined,
    suppressed: () => window.shortcutsSuspended()
  }
}

/** The window's bubble, made now if it has none. */
export function linkStatusFor (window: ShellWindow): LinkStatus {
  let status = statuses.get(window)
  if (status === undefined) {
    status = new LinkStatus(portsFor(window))
    statuses.set(window, status)
  }
  return status
}

/** The window's bubble, or nothing when no link was ever pointed at in it. */
export function existingLinkStatus (window: ShellWindow): LinkStatus | undefined {
  return statuses.get(window)
}

/** The window is gone. */
export function forgetLinkStatus (window: ShellWindow): void {
  statuses.get(window)?.dispose()
  statuses.delete(window)
}
