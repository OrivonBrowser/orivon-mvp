import type { SiteInfo } from '../../main/permissions/site-info.js'
import type { SiteTrust } from '../../main/browsing/site-trust.js'
import type { ApplyResult, SiteDataSnapshot } from '../../main/ipc/site-info-ipc.js'
import type { CapabilityKind, Pattern } from '../../contracts/index.js'
import { closeOnEscape } from '../pages/shared/escape-closes.js'
import type { ApplyOutcome } from '../../main/install/app-updates.js'
import { renderMainPage } from './main-view.js'
import { renderWeb3Page } from './web3-view.js'
import { renderDataPage } from './data-view.js'
import type { SitePermissionsView } from '../../main/site-settings/site-permissions-view.js'
import type { SiteKind } from '../../main/site-settings/kinds.js'
import type { DataPageView } from './data-view.js'

// The site-info popup's whole job: fetch this ONE origin's info, render
// whichever of the three pages is current, and stage capability switches
// until Confirm. No live push channel (unlike the chrome view's
// ShellState) -- the popup is built fresh on every open
// (src/main/permissions/site-info-panel.ts), so there is nothing to keep
// in sync across opens, matching ../settings/main.ts's own reasoning.

interface OrivonSiteInfo {
  get: () => Promise<SiteInfo | null>
  trust: () => Promise<SiteTrust | null>
  data: () => Promise<SiteDataSnapshot | null>
  apply: (changes: ReadonlyArray<{ capability: CapabilityKind, on: boolean, shownPatterns: readonly Pattern[] }>) => Promise<ApplyResult | null>
  sitePermissions: () => Promise<SitePermissionsView | null>
  setSitePermission: (kind: string, value: string) => Promise<SitePermissionsView | null>
  revokePickedPath: (pickId: string) => Promise<SiteInfo | null>
  applyUpdate: (cid: string) => Promise<ApplyOutcome>
  openHome: () => Promise<void>
  clearBrowserData: () => Promise<void>
  removeCookie: (key: string) => Promise<void>
  clearCookies: () => Promise<void>
  reload: () => Promise<void>
  openSiteSettings: () => Promise<void>
  openExtensions: () => Promise<void>
  openCertificate: () => Promise<void>
  reportHeight: (height: number) => void
  close: () => void
  initialPage: 'main' | 'web3'
  origin: string | null
}

declare global {
  interface Window {
    orivonSiteInfo?: OrivonSiteInfo
  }
}

function must<T> (value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}

// A hard throw, unlike newtab.ts's graceful degrade: this popup's preload
// path is fixed at construction (site-info-panel.ts) and never anything
// but preload/site-info.ts, so `orivonSiteInfo` missing here means the
// preload itself failed, not a legitimately unprivileged load.
const bridge = must(window.orivonSiteInfo, 'orivonSiteInfo not exposed -- preload did not run')

closeOnEscape(document, () => { bridge.close() })

const mainSection = must(document.querySelector<HTMLElement>('#main-page'), '#main-page missing')
const web3Section = must(document.querySelector<HTMLElement>('#web3-page'), '#web3-page missing')
const dataSection = must(document.querySelector<HTMLElement>('#data-page'), '#data-page missing')

type Page = 'main' | 'web3' | 'data'

let page: Page = bridge.initialPage
let info: SiteInfo | null = null
let trust: SiteTrust | null = null
let trustFetched = false
const PENDING_RETRY_MS = 2_000
let data: SiteDataSnapshot | null = null
/** Capability -> the switch's staged position, only for a row the person
 * has actually moved this open. Cleared on Confirm/Cancel. */
const staged = new Map<CapabilityKind, boolean>()
let pendingStaleCapabilities = new Set<CapabilityKind>()
let showReloadBanner = false
/** Why the last try at the offered update did not install, shown on its card. */
let updateFailure: string | null = null
/** Null for a site with no per-site settings: an app, which its capability rows already cover. */
let sitePermissions: SitePermissionsView | null = null
/** Kinds the person set in this visit stay listed even when put back to their default. */
const touchedKinds = new Set<SiteKind>()
let permissionsMoreOpen = false
let permissionsChanged = false
let dataView: DataPageView = { cookiesOpen: false, armed: null, deleted: false }
let disarmTimer: ReturnType<typeof setTimeout> | undefined
/** A second press within this long confirms a delete. */
const ARM_MS = 4000

/** Measured from where the content actually ENDS, matching
 * ../settings/main.ts's own reportContentHeight exactly -- see that
 * file's own doc for why `.page`'s own height cannot be used directly. */
function reportContentHeight (): void {
  const root = document.querySelector<HTMLElement>('.page')
  if (root === null) return
  const top = root.getBoundingClientRect().top
  let bottom = top
  for (const child of root.children) {
    if (child instanceof HTMLElement && !child.hidden) bottom = Math.max(bottom, child.getBoundingClientRect().bottom)
  }
  const paddingBottom = parseFloat(getComputedStyle(root).paddingBottom)
  bridge.reportHeight(Math.ceil(bottom - top + paddingBottom))
}

function renderCurrent (): void {
  mainSection.hidden = page !== 'main'
  web3Section.hidden = page !== 'web3'
  dataSection.hidden = page !== 'data'

  if (page === 'main' && info !== null) {
    const permissions = sitePermissions === null ? null : { view: sitePermissions, touched: touchedKinds, moreOpen: permissionsMoreOpen, changed: permissionsChanged }
    renderMainPage(mainSection, info, trust, staged, pendingStaleCapabilities, showReloadBanner, permissions, {
      onToggle: (capability, next) => {
        pendingStaleCapabilities.delete(capability)
        const originalRow = info?.capabilityRows.find((r) => r.capability === capability)
        if (originalRow !== undefined && originalRow.on === next) staged.delete(capability)
        else staged.set(capability, next)
        renderCurrent()
      },
      onRevokePickedPath: (pickId) => { void revokePickedPathAndRefresh(pickId) },
      onConfirm: () => { void confirmStaged() },
      onCancel: () => { staged.clear(); pendingStaleCapabilities = new Set(); renderCurrent() },
      onOpenWeb3: () => { void openWeb3() },
      onOpenData: () => { void openData() },
      onOpenCertificate: () => { void bridge.openCertificate() },
      onOpenSiteSettings: () => { void bridge.openSiteSettings() },
      permissions: {
        onChoose: (kind, value) => { void chooseSitePermission(kind, value) },
        onToggleMore: () => { permissionsMoreOpen = !permissionsMoreOpen; renderCurrent() },
        onReload: () => { void bridge.reload() }
      },
      onManageExtensions: () => { void bridge.openExtensions() },
      onReload: () => { void bridge.reload() },
      onApplyUpdate: (cid) => { void applyUpdate(cid) },
      onOpenHome: () => { void bridge.openHome() }
    }, updateFailure)
  } else if (page === 'web3') {
    renderWeb3Page(web3Section, trust, () => { page = 'main'; renderCurrent() })
  } else if (page === 'data' && info !== null) {
    renderDataPage(dataSection, data, info.pickedPathRows, dataView, {
      onBack: () => { page = 'main'; renderCurrent() },
      onClearBrowserData: () => { press('site', clearBrowserData) },
      onToggleCookies: () => { dataView = { ...dataView, cookiesOpen: !dataView.cookiesOpen }; renderCurrent() },
      onRemoveCookie: (key) => { void removeCookie(key) },
      onClearCookies: () => { press('cookies', clearCookies) },
      onReload: () => { void bridge.reload() },
      onRevokePickedPath: (pickId) => { void revokePickedPathAndRefresh(pickId) }
    })
  }
  reportContentHeight()
}

/** Takes the offered update. Main asks the confirmation Trust & Force needs; the tabs reload when it installs, and this popup is done. */
async function applyUpdate (cid: string): Promise<void> {
  const outcome = await bridge.applyUpdate(cid)
  if (outcome.ok) {
    bridge.close()
    return
  }
  updateFailure = outcome.reason === 'declined' ? null : `Could not switch: ${outcome.reason}`
  info = await bridge.get()
  renderCurrent()
}

async function ensureTrust (): Promise<void> {
  if (trustFetched) return
  trustFetched = true
  trust = await bridge.trust()
  if (trust?.judged.status === 'pending' || trust?.homePending === true) setTimeout(() => { void refreshPendingTrust() }, PENDING_RETRY_MS)
}

/** The Web3 Score provider was still being asked: ask again until it answers, then repaint. */
async function refreshPendingTrust (): Promise<void> {
  trust = await bridge.trust()
  renderCurrent()
  if (trust?.judged.status === 'pending' || trust?.homePending === true) setTimeout(() => { void refreshPendingTrust() }, PENDING_RETRY_MS)
}

async function openWeb3 (): Promise<void> {
  page = 'web3'
  renderCurrent() // paint immediately with whatever trust is already known
  await ensureTrust()
  if (page === 'web3') renderCurrent()
}

async function openData (): Promise<void> {
  page = 'data'
  renderCurrent()
  data = await bridge.data()
  if (page === 'data') renderCurrent()
}

async function confirmStaged (): Promise<void> {
  if (info === null || staged.size === 0) return
  const changes = [...staged.entries()].map(([capability, on]) => {
    const row = info?.capabilityRows.find((r) => r.capability === capability)
    return { capability, on, shownPatterns: row?.patterns ?? [] }
  })
  const result = await bridge.apply(changes)
  staged.clear()
  if (result === null) { renderCurrent(); return }
  info = result.info
  pendingStaleCapabilities = new Set(result.staleCapabilities)
  showReloadBanner = result.staleCapabilities.length + result.refusedCapabilities.length < changes.length
  renderCurrent()
}

async function chooseSitePermission (kind: SiteKind, value: string): Promise<void> {
  const next = await bridge.setSitePermission(kind, value)
  // A refusal changed nothing: draw again so the select goes back to what is stored.
  if (next === null) { renderCurrent(); return }
  touchedKinds.add(kind)
  sitePermissions = next
  permissionsChanged = true
  renderCurrent()
}

async function revokePickedPathAndRefresh (pickId: string): Promise<void> {
  const result = await bridge.revokePickedPath(pickId)
  if (result !== null) info = result
  renderCurrent()
}

/** First press arms a deleting button, the second (within `ARM_MS`) does it. */
function press (target: 'cookies' | 'site', run: () => Promise<void>): void {
  if (disarmTimer !== undefined) clearTimeout(disarmTimer)
  disarmTimer = undefined
  if (dataView.armed === target) {
    dataView = { ...dataView, armed: null }
    renderCurrent()
    void run()
    return
  }
  dataView = { ...dataView, armed: target }
  disarmTimer = setTimeout(() => { dataView = { ...dataView, armed: null }; renderCurrent() }, ARM_MS)
  renderCurrent()
  document.getElementById(target === 'cookies' ? 'clear-cookies' : 'clear-site')?.focus()
}

/** Whatever was deleted, the page reads again and the tab is asked to reload to show it. */
async function afterDelete (): Promise<void> {
  dataView = { ...dataView, deleted: true }
  showReloadBanner = true
  data = await bridge.data()
  renderCurrent()
}

async function clearBrowserData (): Promise<void> {
  await bridge.clearBrowserData()
  await afterDelete()
}

async function clearCookies (): Promise<void> {
  await bridge.clearCookies()
  await afterDelete()
}

async function removeCookie (key: string): Promise<void> {
  await bridge.removeCookie(key)
  await afterDelete()
  // The row that held the keyboard is gone: it goes to the next delete button, or the list's toggle.
  document.querySelector<HTMLElement>('.cookie-row .icon-btn, #cookies-toggle')?.focus()
}

async function init (): Promise<void> {
  const [loaded, permissions] = await Promise.all([bridge.get(), bridge.sitePermissions()])
  info = loaded
  sitePermissions = permissions
  renderCurrent()
  // Always fetched, not only when opening the Web3 page: the main page's
  // own connection row needs the real secure/insecure/cached state too,
  // never the "Web3 Score" placeholder past the very first paint.
  await ensureTrust()
  renderCurrent()
}

void init()
