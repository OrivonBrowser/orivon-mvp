import type { SiteInfo } from '../../main/permissions/site-info.js'
import type { SiteTrust } from '../../main/browsing/site-trust.js'
import type { ApplyResult, SiteDataSnapshot } from '../../main/ipc/site-info-ipc.js'
import type { CapabilityKind, Pattern } from '../../contracts/index.js'
import { renderMainPage } from './main-view.js'
import { renderWeb3Page } from './web3-view.js'
import { renderDataPage } from './data-view.js'

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
  revokePickedPath: (pickId: string) => Promise<SiteInfo | null>
  clearBrowserData: () => Promise<void>
  reload: () => Promise<void>
  openAllSites: () => Promise<void>
  reportHeight: (height: number) => void
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

const mainSection = must(document.querySelector<HTMLElement>('#main-page'), '#main-page missing')
const web3Section = must(document.querySelector<HTMLElement>('#web3-page'), '#web3-page missing')
const dataSection = must(document.querySelector<HTMLElement>('#data-page'), '#data-page missing')

type Page = 'main' | 'web3' | 'data'

let page: Page = bridge.initialPage
let info: SiteInfo | null = null
let trust: SiteTrust | null = null
let trustFetched = false
let data: SiteDataSnapshot | null = null
/** Capability -> the switch's staged position, only for a row the person
 * has actually moved this open. Cleared on Confirm/Cancel. */
const staged = new Map<CapabilityKind, boolean>()
let pendingStaleCapabilities = new Set<CapabilityKind>()
let showReloadBanner = false

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
    renderMainPage(mainSection, info, trust, staged, pendingStaleCapabilities, showReloadBanner, {
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
      onOpenAllSites: () => { void bridge.openAllSites() },
      onReload: () => { void bridge.reload() }
    })
  } else if (page === 'web3') {
    renderWeb3Page(web3Section, trust, () => { page = 'main'; renderCurrent() })
  } else if (page === 'data' && info !== null) {
    renderDataPage(dataSection, data, info.pickedPathRows, {
      onBack: () => { page = 'main'; renderCurrent() },
      onClearBrowserData: () => { void clearBrowserData() },
      onRevokePickedPath: (pickId) => { void revokePickedPathAndRefresh(pickId) }
    })
  }
  reportContentHeight()
}

async function ensureTrust (): Promise<void> {
  if (trustFetched) return
  trustFetched = true
  trust = await bridge.trust()
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
  showReloadBanner = result.staleCapabilities.length < changes.length
  renderCurrent()
}

async function revokePickedPathAndRefresh (pickId: string): Promise<void> {
  const result = await bridge.revokePickedPath(pickId)
  if (result !== null) info = result
  renderCurrent()
}

async function clearBrowserData (): Promise<void> {
  await bridge.clearBrowserData()
  data = await bridge.data()
  renderCurrent()
}

async function init (): Promise<void> {
  info = await bridge.get()
  renderCurrent()
  if (page === 'web3') await ensureTrust()
  renderCurrent()
}

void init()
