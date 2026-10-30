// The toolbar popovers one window owns: the Available networks list and the
// site-info card, and what they need to open one from the other. Built once per
// window and handed to the overlay host, which closes them with every overlay.
import { app, session, type BaseWindow } from 'electron'
import { deleteLocalFileData } from '../local-files/delete-local-file-data.js'
import { isOriginPinnedSync, isOriginServedFromCacheSync, pinCoverageFor } from '../../loader/electron/serve.js'
import { verifierNameEvidence } from '../verifier/verifier-subsystem.js'
import { createSiteInfoController } from '../permissions/site-info-controller.js'
import type { SiteInfoController } from '../permissions/site-info-controller.js'
import { deliveryLevelOverrideFor, scoreLevelOverrideFor } from '../dev/score-levels.js'
import { localDdocHashFor } from '../dev/local-ddoc.js'
import { createNetworksPanel } from '../networks/networks-panel.js'
import { createSiteInfoPanel } from '../permissions/site-info-panel.js'
import { browserTunnels, proxySetup } from '../permissions/proxy-setup.js'
import { openWeb3ScoreHelp } from '../web3-score/web3-score-help.js'
import { openCertificate } from '../auth/certificate-open.js'
import { pageAccess } from '../site-settings/page-access.js'
import { sitePermissions } from '../site-settings/site-permissions-view.js'
import { siteSettingsControllerFor } from '../site-settings/site-settings-runner.js'
import type { SubsystemContext } from '../registry.js'
import type { OverlayHostHandle } from '../overlays/overlay-host.js'
import { extensionPopupPanel } from '../extensions/extension-popup-host.js'
import type { ShellServices } from './shell-services.js'
import type { TabManager } from './tabs.js'
import { openFromActiveTab } from './open-from-browser.js'
import { browserTunnelTabs } from './tab-tunnel-facts.js'
import { addressOfTab, openingAddressOf } from './tunnel-popover-tab.js'
import { reloadFromCard } from './reload-from-card.js'
import { firstVisitNow } from '../app-setup/tab-setup-ref.js'
import { announceEntryChange } from '../app-setup/entry-changes.js'

export interface WindowPanelsDeps {
  readonly ctx: SubsystemContext
  readonly win: BaseWindow
  readonly services: ShellServices
  readonly tabs: TabManager
  readonly overlays: OverlayHostHandle
  readonly dirname: string
}

export interface WindowPanels {
  readonly networks: ReturnType<typeof createNetworksPanel>
  readonly siteInfo: ReturnType<typeof createSiteInfoPanel>
  /** The site-info popover's controller, which the chrome's IPC also reaches. */
  readonly siteInfoController: SiteInfoController
}

export function createWindowPanels ({ ctx, win, services, tabs, overlays, dirname }: WindowPanelsDeps): WindowPanels {
  // The site-info popup's own door
  // (site-info-controller.ts's own header). `isOriginServedFromCacheSync`/`pinCoverageFor`/`verifierNameEvidence`
  // are the real implementations `SiteTrustSources` asks for -- injected here
  // rather than imported by the controller itself, so it stays testable
  // against a fake session (that file's own doc).
  // `scoreLevelOverrideFor`/`deliveryLevelOverrideFor` (`../dev/score-levels.ts`)
  // and `localDdocHashFor` (`../dev/local-ddoc.ts`) are developer-only: no-ops
  // outside developer mode.
  const siteInfoController = createSiteInfoController(ctx, { isOriginServedFromCacheSync, isOriginPinnedSync, pinCoverageFor, nameEvidenceFor: verifierNameEvidence, levelOverrideFor: scoreLevelOverrideFor, deliveryOverrideFor: deliveryLevelOverrideFor, localDdocHashFor, providerVerdictFor: services.scoreProvider.verdictFor },
    async (key) => await deleteLocalFileData({ broker: ctx.broker, userDataPath: app.getPath('userData'), clearPartition: async (partition) => { await session.fromPartition(partition).clearData() } }, key),
    // The first visit is built after the windows, so it is read at the moment of use.
    { notLetIn: (origin) => firstVisitNow()?.notLetIn(origin), askAgain: async (origin) => await firstVisitNow()?.askAgain(origin) ?? false, changed: announceEntryChange },
    // The proxy's address is set from the tunnel menu as Settings sets it: through the same store, so it is checked, saved and followed the same way.
    proxySetup(ctx, services.settings),
    // The tunnel popover opened for a tab reads and sets the tab's own choice: the same call a test seam makes, so nothing else decides it.
    { choiceOf: (id) => { const record = tabs.record(id); const address = addressOfTab(tabs.getState(), id, openingAddressOf(tabs)); return record === undefined ? undefined : { choice: record.tunnelChoice, ...(address === undefined ? {} : { address }) } }, set: (id, choice) => { tabs.setTunnelChoice(id, choice) } },
    // The Browser-wide panel moves the same three settings Settings does, and lists the tabs of every window that keep a choice of their own.
    browserTunnels(services.settings, () => browserTunnelTabs(services.windows)))

  // The networks list is a panel inside this window rather than a second one -- ../networks/networks-panel.ts.
  const networks = createNetworksPanel(win, win.contentView, services.networks, dirname, () => tabs.activeWebContents())

  const siteInfo = createSiteInfoPanel(
    win, win.contentView, siteInfoController, app.getPath('userData'),
    () => tabs.activeWebContents(),
    () => { reloadFromCard(siteInfo, tabs) },
    // The "Site settings" row, and the tunnel list's links: the popover gives way to a Settings section.
    (path = '/sites') => {
      siteInfo.close()
      tabs.openInternal('settings', path)
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
    // "Open <the home an app names>": a new tab at that name, in the tunnel of the tab the popover is about.
    (domain) => {
      siteInfo.close()
      openFromActiveTab(tabs, `https://${domain}/`)
    },
    // A "?" on the Web3 Score page: the page that says what the levels mean, in a new tab.
    () => {
      siteInfo.close()
      openWeb3ScoreHelp(tabs)
    },
    // "Report a problem with this site": a new tab at the address the app's manifest names, in the tunnel of the tab the popover is about.
    (url) => {
      siteInfo.close()
      openFromActiveTab(tabs, url)
    },
    dirname
  )

  overlays.adopt(networks, networks.restack)
  overlays.adopt(siteInfo, siteInfo.restack)
  // An extension's popup is a view in this window: lifted above the bars with each state push, never closed by the host.
  const extensionPopup = extensionPopupPanel(win)
  overlays.adopt(extensionPopup, extensionPopup.restack)
  return { networks, siteInfo, siteInfoController }
}
