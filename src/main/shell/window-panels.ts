// The toolbar popovers one window owns: the all-sites permissions list and the
// site-info card, and what they need to open one from the other. Built once per
// window and handed to the overlay host, which closes them with every overlay.
import { app, type BaseWindow } from 'electron'
import { isOriginServedFromCacheSync, pinCoverageFor } from '../../loader/electron/serve.js'
import { verifierNameEvidence } from '../verifier/verifier-subsystem.js'
import { createPermissionsController, createSiteNotificationsController } from '../permissions/permissions.js'
import { notificationDecisions } from '../sessions/permission-gate.js'
import { createSiteInfoController } from '../permissions/site-info-controller.js'
import type { SiteInfoController } from '../permissions/site-info-controller.js'
import { deliveryLevelOverrideFor, scoreLevelOverrideFor } from '../dev/score-levels.js'
import { localDdocFor } from '../dev/local-ddoc.js'
import { createPermissionsPanel } from '../permissions/permissions-panel.js'
import { createSiteInfoPanel } from '../permissions/site-info-panel.js'
import type { SubsystemContext } from '../registry.js'
import type { OverlayHostHandle } from '../overlays/overlay-host.js'
import type { SiteInfoMemory } from './window-actions.js'
import type { ShellServices } from './shell-services.js'
import type { TabManager } from './tabs.js'

export interface WindowPanelsDeps {
  readonly ctx: SubsystemContext
  readonly win: BaseWindow
  readonly services: ShellServices
  readonly tabs: TabManager
  readonly overlays: OverlayHostHandle
  /** Where the toolbar ends: an anchor with no rect of its own opens here. */
  readonly chromeHeight: () => number
  readonly dirname: string
}

export interface WindowPanels {
  readonly permissions: ReturnType<typeof createPermissionsPanel>
  readonly siteInfo: ReturnType<typeof createSiteInfoPanel>
  /** What the site-info popover last opened on. */
  readonly memory: SiteInfoMemory
  /** The site-info popover's controller, which the chrome's IPC also reaches. */
  readonly siteInfoController: SiteInfoController
}

export function createWindowPanels ({ ctx, win, services, tabs, overlays, chromeHeight, dirname }: WindowPanelsDeps): WindowPanels {
  // Queue item 4.4: the all-sites popup reads/revokes through this one
  // controller, closing over `ctx` so it always sees whichever broker is
  // currently published (permissions.ts's own doc). `scoreLevelOverrideFor`
  // is the developer-only preview path (ADR-0037, ../dev/score-levels.ts).
  const permissionsController = createPermissionsController(ctx, scoreLevelOverrideFor)

  // The site-info popup's own door, sibling to `permissions` above
  // (site-info-controller.ts's own header on why it is not folded into
  // that one). `isOriginServedFromCacheSync`/`pinCoverageFor`/`verifierNameEvidence`
  // are the real implementations `SiteTrustSources` asks for -- injected here
  // rather than imported by the controller itself, so it stays testable
  // against a fake session (that file's own doc).
  // `scoreLevelOverrideFor`/`deliveryLevelOverrideFor` (`../dev/score-levels.ts`)
  // and `localDdocFor` (`../dev/local-ddoc.ts`) are developer-only: no-ops
  // outside developer mode.
  const siteInfoController = createSiteInfoController(ctx, { isOriginServedFromCacheSync, pinCoverageFor, nameEvidenceFor: verifierNameEvidence, levelOverrideFor: scoreLevelOverrideFor, deliveryOverrideFor: deliveryLevelOverrideFor, localDdocFor })

  // The permissions surface is a panel inside this window rather than a
  // second one -- ./permissions-panel.ts.
  const permissions = createPermissionsPanel(win, win.contentView, permissionsController, dirname, createSiteNotificationsController(notificationDecisions()))

  // Remembers the anchor and origin the site-info popup was last opened
  // with, so its own "Site settings" row (./site-info-panel.js's
  // `openAllSites` parameter) has somewhere sensible to open the all-sites
  // popup -- that row has no anchor of its own to measure.
  const memory: SiteInfoMemory = { anchor: null, origin: undefined }

  const siteInfo = createSiteInfoPanel(
    win, win.contentView, siteInfoController, app.getPath('userData'),
    () => tabs.activeWebContents(),
    () => {
      const { activeTabId } = tabs.getState()
      if (activeTabId !== null) tabs.reload(activeTabId)
    },
    () => {
      siteInfo.close()
      permissions.toggle(memory.anchor ?? { x: 0, y: chromeHeight(), width: 0, height: 0 }, memory.origin)
    },
    // The extensions disclosure's own "Manage" link: the same
    // close-then-navigate shape as the row above, but to a real page
    // (`tabs.openInternal`), since `orivon://extensions` is a full page.
    () => {
      siteInfo.close()
      tabs.openInternal('extensions')
    },
    dirname
  )

  overlays.adopt(permissions)
  overlays.adopt(siteInfo)
  return { permissions, siteInfo, memory, siteInfoController }
}
