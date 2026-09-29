// The permissions panel's own command channel -- list every app's grants,
// revoke one. The sender must be the panel's own top frame, by identity;
// unlike ipc.ts's `isFromChrome` its URL is not compared too, and whether it
// should be is open-questions.md A269. The panel's view is locked to its
// document (lock-navigation.ts) and its preload gates on the URL. The handler
// is registered on the panel's own webContents, so it goes when the panel
// does -- see permissions-panel.ts.

import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { LIGHT_CLIENT_STATUS_CHANNEL, PERMISSIONS_COMMAND_CHANNEL } from '../channels.js'
import type { LightClientView } from '../verifier/status-view.js'
import type { AppPermissions, PermissionsController, SiteNotificationRow, SiteNotificationsController } from '../permissions/permissions.js'
import type { CapabilityKind, GrantId } from '../../contracts/index.js'

export type PermissionsCommand =
  | { type: 'list' }
  | { type: 'revoke', origin: string, grantId: GrantId }
  /** For an app that is not loaded this session: its grants live only on disk
   * and have no live id, so the capability itself is the address. An origin
   * holds at most one grant per capability, so this is not ambiguous. */
  | { type: 'revokeCapability', origin: string, capability: CapabilityKind }
  /** D-0007's own revoke button, addressed by pickId -- a picked path is
   * never a CapabilityKind, so `revokeCapability` cannot reach it. */
  | { type: 'revokePickedPath', origin: string, pickId: string }
  /** How tall the rendered list actually is, so the panel can size itself to
   * its content the way a toolbar popup does. Sent by the page after every
   * render, because the list arrives over IPC and the first paint is always
   * an empty one. Advisory: permissions-panel.ts clamps it. */
  | { type: 'contentHeight', height: number }
  /** Each site's remembered notification answer: a Chromium permission, not
   * a grant, so its own list. Reset forgets one, and the site asks again. */
  | { type: 'listSiteNotifications' }
  | { type: 'resetSiteNotifications', origin: string }
  /** The Ethereum light client's state, read-only. Changes are pushed on LIGHT_CLIENT_STATUS_CHANNEL while the panel is open. */
  | { type: 'lightClient' }

export interface LightClientSource {
  view: () => LightClientView
  /** Returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void
}

/** Identity alone is not enough (open-questions.md A269): a `senderFrame`
 * reference can survive a navigation Electron re-points it after, so the
 * URL is checked too, the same defence-in-depth ../ipc.ts's own
 * `isFromChrome` already applies to COMMAND_CHANNEL. `panelUrl` is the
 * address this popup was created with, which `lock-navigation.ts` refuses
 * to ever change. */
function isFromPermissionsPanel (event: IpcMainInvokeEvent, permissionsWebContents: WebContents, panelUrl: string): boolean {
  return event.senderFrame !== null && event.senderFrame === permissionsWebContents.mainFrame && event.senderFrame.url === panelUrl
}

export function registerPermissionsIpc (
  permissionsWebContents: WebContents,
  panelUrl: string,
  permissions: PermissionsController,
  onContentHeight: (height: number) => void = () => {},
  sites?: SiteNotificationsController,
  lightClient?: LightClientSource
): () => void {
  const unsubscribe = lightClient?.subscribe(() => {
    if (!permissionsWebContents.isDestroyed()) permissionsWebContents.send(LIGHT_CLIENT_STATUS_CHANNEL, lightClient.view())
  })
  // On the panel's own webContents: the handler goes with it, and two windows
  // can each have one open.
  permissionsWebContents.ipc.handle(PERMISSIONS_COMMAND_CHANNEL, (event: IpcMainInvokeEvent, command: PermissionsCommand): void | readonly SiteNotificationRow[] | LightClientView | null | Promise<void | readonly AppPermissions[]> => {
    if (!isFromPermissionsPanel(event, permissionsWebContents, panelUrl)) return

    switch (command.type) {
      case 'list':
        return permissions.list()
      case 'revoke':
        return permissions.revoke(command.origin, command.grantId)
      case 'revokeCapability':
        return permissions.revokeCapability(command.origin, command.capability)
      case 'revokePickedPath':
        return permissions.revokePickedPath(command.origin, command.pickId)
      case 'contentHeight':
        // Number.isFinite, not a bare typeof check: NaN and Infinity are both
        // numbers, and either would reach setBounds as a corrupt height.
        if (Number.isFinite(command.height)) onContentHeight(command.height)
        return
      case 'listSiteNotifications':
        return sites?.list() ?? []
      case 'resetSiteNotifications':
        // Typed on the wire, not trusted: the renderer picks the payload.
        if (typeof command.origin === 'string') sites?.reset(command.origin)
        return
      case 'lightClient':
        return lightClient?.view() ?? null
    }
  })
  return () => { unsubscribe?.() }
}
