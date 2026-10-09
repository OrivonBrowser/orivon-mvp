// The toolbar popovers one window owns: the all-sites permissions list and the
// site-info card, and what they need to open one from the other. Built once per
// window and handed to the overlay host, which closes them with every overlay.
import { app, session, type BaseWindow } from 'electron'
import { deleteLocalFileData } from '../local-files/delete-local-file-data.js'
import { isOriginPinnedSync, isOriginServedFromCacheSync, pinCoverageFor } from '../../loader/electron/serve.js'
import { verifierNameEvidence } from '../verifier/verifier-subsystem.js'
import { createPermissionsController, createSiteNotificationsController } from '../permissions/permissions.js'
import { notificationDecisions } from '../sessions/permission-gate.js'
import { createSiteInfoController } from '../permissions/site-info-controller.js'
import type { SiteInfoController } from '../permissions/site-info-controller.js'
import { deliveryLevelOverrideFor, scoreLevelOverrideFor } from '../dev/score-levels.js'
import { localDdocHashFor } from '../dev/local-ddoc.js'
import { createPermissionsPanel } from '../permissions/permissions-panel.js'
import { createSiteInfoPanel } from '../permissions/site-info-panel.js'
import { openCertificate } from '../auth/certificate-open.js'
import { pageAccess } from '../site-settings/page-access.js'
import { sitePermissions } from '../site-settings/site-permissions-view.js'
import { siteSettingsControllerFor } from '../site-settings/site-settings-runner.js'
import type { SubsystemContext } from '../registry.js'
import type { OverlayHostHandle } from '../overlays/overlay-host.js'
import { extensionPopupPanel } from '../extensions/extension-popup-host.js'
import type { ShellServices } from './shell-services.js'
import type { TabManager } from './tabs.js'
import { reloadFromCard } from './reload-from-card.js'

export interface WindowPanelsDeps {
  readonly ctx: SubsystemContext
  readonly win: BaseWindow
  readonly services: ShellServices
  readonly tabs: TabManager
  readonly overlays: OverlayHostHandle
  readonly dirname: string
}

export interface WindowPanels {
  readonly permissions: ReturnType<typeof createPermissionsPanel>
  readonly siteInfo: ReturnType<typeof createSiteInfoPanel>
  /** The site-info popover's controller, which the chrome's IPC also reaches. */
  readonly siteInfoController: SiteInfoController
}

export function createWindowPanels ({ ctx, win, services, tabs, overlays, dirname }: WindowPanelsDeps): WindowPanels {
  // The all-sites popup reads and revokes through this one controller,
  // closing over `ctx` so it always sees whichever broker is currently
  // published (permissions.ts's own doc). `scoreLevelOverrideFor` is the
  // developer-only preview path (../dev/score-levels.ts).
  const permissionsController = createPermissionsController(ctx, scoreLevelOverrideFor)

  // The site-info popup's own door, sibling to `permissions` above
  // (site-info-controller.ts's own header on why it is not folded into
  // that one). `isOriginServedFromCacheSync`/`pinCoverageFor`/`verifierNameEvidence`
  // are the real implementations `SiteTrustSources` asks for -- injected here
  // rather than imported by the controller itself, so it stays testable
  // against a fake session (that file's own doc).
  // `scoreLevelOverrideFor`/`deliveryLevelOverrideFor` (`../dev/score-levels.ts`)
  // and `localDdocHashFor` (`../dev/local-ddoc.ts`) are developer-only: no-ops
  // outside developer mode.
  const siteInfoController = createSiteInfoController(ctx, { isOriginServedFromCacheSync, isOriginPinnedSync, pinCoverageFor, nameEvidenceFor: verifierNameEvidence, levelOverrideFor: scoreLevelOverrideFor, deliveryOverrideFor: deliveryLevelOverrideFor, localDdocHashFor, providerVerdictFor: services.scoreProvider.verdictFor },
    async (key) => await deleteLocalFileData({ broker: ctx.broker, userDataPath: app.getPath('userData'), clearPartition: async (partition) => { await session.fromPartition(partition).clearData() } }, key))

  // The permissions surface is a panel inside this window rather than a
  // second one -- ./permissions-panel.ts.
  const permissions = createPermissionsPanel(win, win.contentView, permissionsController, dirname, createSiteNotificationsController(notificationDecisions()), () => {
    permissions.close()
    tabs.openInternal('settings', '/sites')
  }, () => tabs.activeWebContents())

  const siteInfo = createSiteInfoPanel(
    win, win.contentView, siteInfoController, app.getPath('userData'),
    () => tabs.activeWebContents(),
    () => { reloadFromCard(siteInfo, tabs) },
    // The "Site settings" row: the popover gives way to the Settings section.
    () => {
      siteInfo.close()
      tabs.openInternal('settings', '/sites')
    },
    // The extensions disclosure's own "Manage" link: the same
    // close-then-navigate shape as the row above, but to a real page
    // (`tabs.openInternal`), since `orivon://extensions` is a full page.
    () => {
      siteInfo.close()
      tabs.openInternal('extensions')
    },
    // The Certificate row: the popover gives way to the certificate viewer of the tab in front.
    () => {
      siteInfo.close()
      openCertificate({ tabs, overlays })
    },
    // Reads the page in front for what it asked, never anything the popover sends.
    sitePermissions({
      controller: siteSettingsControllerFor(services, ctx),
      requested: (origin) => {
        const tab = tabs.activeWebContents()
        return tab !== undefined && pageAccess.originOf(tab) === origin ? pageAccess.entries(tab).map((entry) => entry.kind) : []
      },
      isPrivate: services.isPrivate
    }),
    // "Open <the home an app names>": a new tab at that name.
    (domain) => {
      siteInfo.close()
      tabs.createTab(`https://${domain}/`)
    },
    dirname
  )

  overlays.adopt(permissions, permissions.restack)
  overlays.adopt(siteInfo, siteInfo.restack)
  // An extension's popup is a view in this window: lifted above the bars with each state push, never closed by the host.
  const extensionPopup = extensionPopupPanel(win)
  overlays.adopt(extensionPopup, extensionPopup.restack)
  return { permissions, siteInfo, siteInfoController }
}
