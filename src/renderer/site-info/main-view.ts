import type { SiteInfo, SiteCapabilityRow } from '../../main/permissions/site-info.js'
import type { SiteTrust } from '../../main/browsing/site-trust.js'
import { createSwitch } from './switch.js'
import { chevronIcon } from './icons.js'
import { paintShield, web3Shield } from '../web3-shield.js'
import { grantIcon } from '../grant-icons.js'
import { renderSitePermissions } from './permissions-view.js'
import type { PermissionsCallbacks, PermissionsModel } from './permissions-view.js'
import { homeLine, originHost } from '../../trust/domain-binding.js'
import { renderUpdateCard } from './update-card.js'

// The site-info popup's main page -- Chrome's own layout (a connection
// row, then one switch per permission the site actually asked for), with
// Orivon's own content on top of it: the claimed-name line, a Web3 Score
// glance, and staged changes with a Confirm step rather than each switch
// taking effect the instant it moves (this.js's own `applyOnConfirm`
// callback is what a real grant/revoke waits for).
//
// Never innerHTML (security-model.md T1/T10/T12/T17), matching
// ../settings/permissions-view.ts: `info.claimedName` and every row's
// `message` both ultimately trace back to app-controlled input.

export interface MainPageCallbacks {
  readonly onToggle: (capability: SiteCapabilityRow['capability'], next: boolean) => void
  readonly onRevokePickedPath: (pickId: string) => void
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly onOpenWeb3: () => void
  readonly onOpenData: () => void
  readonly onOpenCertificate: () => void
  readonly onOpenSiteSettings: () => void
  readonly onManageExtensions: () => void
  readonly onReload: () => void
  readonly onApplyUpdate: (cid: string) => void
  readonly onOpenHome: () => void
  readonly permissions: PermissionsCallbacks
}

function connectionLabel (connection: SiteTrust['connection']): string {
  switch (connection) {
    case 'cached': return 'Running from local cache, pinned'
    case 'secure': return 'Connection is secure'
    case 'insecure': return 'Connection is not secure'
  }
}

/** One short line naming the displayed Website level and Delivery level;
 * per-app connections are never observed, so they stay `?`
 * (`src/trust/README.md`). Names a developer override, a provider's
 * judgement, or a DDOC counted only in developer mode, rather than letting
 * any of them read as observed (ADR-0006). */
function trustGlance (trust: SiteTrust | null): string {
  if (trust === null) return 'Web3 Score'
  const overridden = trust.levelOverride !== undefined || trust.deliveryOverride !== undefined
  const judgedBy = trust.judgedShown && trust.judged.status === 'judged' ? ` (judged by ${trust.judged.provider.name})` : ''
  const glance = `Web3 Score · Website L${String(trust.displayedLevel)}${judgedBy} · Delivery D${String(trust.displayedDelivery)} · Connections ?`
  if (overridden) return `${glance} (developer override)`
  return trust.ddoc.status === 'local-dev' ? `${glance} (developer mode)` : glance
}

/** `kind` is a sibling appended BEFORE `.row-message`, never inside it --
 * matching `../settings/permissions-view.ts`'s own row icon. */
function row (kind: Parameters<typeof grantIcon>[0], message: string, warning: boolean, control: HTMLElement): HTMLElement {
  const li = document.createElement('li')
  li.className = 'row'
  li.classList.toggle('warning', warning)
  const text = document.createElement('span')
  text.className = 'row-message'
  text.textContent = message
  li.append(grantIcon(kind), text, control)
  return li
}

/** The path a local-file key names, as a person reads it: no scheme, no percent codes. */
function pathOfKey (key: string): string {
  try {
    return decodeURIComponent(new URL(key).pathname)
  } catch {
    return key
  }
}

/** What stands in the place of the Web3 Score for a local file: Orivon cannot check it, so it shows no level. */
function localFileNote (): HTMLElement {
  const note = document.createElement('div')
  note.className = 'local-file-note'
  const label = document.createElement('span')
  label.className = 'connection-label'
  label.textContent = 'Local file'
  const glance = document.createElement('span')
  glance.className = 'connection-glance'
  glance.textContent = 'Orivon cannot check files on your computer: no Web3 Score, no pinned copy.'
  note.append(label, glance)
  return note
}

export function renderMainPage (
  container: HTMLElement,
  info: SiteInfo,
  trust: SiteTrust | null,
  staged: ReadonlyMap<SiteCapabilityRow['capability'], boolean>,
  pendingStaleCapabilities: ReadonlySet<SiteCapabilityRow['capability']>,
  showReloadBanner: boolean,
  permissions: PermissionsModel | null,
  callbacks: MainPageCallbacks,
  updateFailure: string | null = null
): void {
  container.replaceChildren()

  const header = document.createElement('header')
  header.className = 'site-header'
  const origin = document.createElement('div')
  origin.className = 'site-origin'
  const isFile = info.origin.startsWith('file:')
  origin.textContent = isFile ? pathOfKey(info.origin) : info.displayOrigin
  header.append(origin)
  if (info.claimedName !== undefined) {
    const claim = document.createElement('div')
    claim.className = 'site-claim'
    claim.textContent = `Claims to be "${info.claimedName}".`
    header.append(claim)
  }
  const home = homeLine(originHost(info.origin), info.homeDomain)
  if (home !== undefined) {
    const homeEl = document.createElement('div')
    homeEl.className = 'site-claim site-home'
    homeEl.textContent = home
    header.append(homeEl)
    if (info.homeDomain !== undefined) {
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'link-button'
      open.textContent = `Open ${info.homeDomain}`
      open.addEventListener('click', callbacks.onOpenHome)
      header.append(open)
    }
  }
  container.append(header)
  if (info.update !== undefined) container.append(renderUpdateCard(info.update, updateFailure, { onApply: callbacks.onApplyUpdate }))

  if (isFile) {
    container.append(localFileNote())
  } else {
    const connectionRow = document.createElement('button')
    connectionRow.type = 'button'
    connectionRow.className = `connection-row ${trust?.connection ?? 'unknown'}`
    const shield = web3Shield()
    paintShield(shield, trust?.displayedLevel ?? null)
    connectionRow.append(shield)
    const connectionText = document.createElement('span')
    connectionText.className = 'connection-text'
    const connectionLabelEl = document.createElement('span')
    connectionLabelEl.className = 'connection-label'
    connectionLabelEl.textContent = trust === null ? 'Web3 Score' : connectionLabel(trust.connection)
    const connectionGlanceEl = document.createElement('span')
    connectionGlanceEl.className = 'connection-glance'
    connectionGlanceEl.textContent = trustGlance(trust)
    connectionText.append(connectionLabelEl, connectionGlanceEl)
    connectionRow.append(connectionText, chevronIcon())
    connectionRow.addEventListener('click', callbacks.onOpenWeb3)
    container.append(connectionRow)
  }

  // The certificate only exists for a page that came over https.
  if (info.origin.startsWith('https://')) {
    const certificateRow = document.createElement('button')
    certificateRow.type = 'button'
    certificateRow.className = 'nav-row certificate-row'
    const certificateLabel = document.createElement('span')
    certificateLabel.textContent = 'Certificate'
    certificateRow.append(certificateLabel, chevronIcon())
    certificateRow.addEventListener('click', callbacks.onOpenCertificate)
    container.append(certificateRow)
  }

  if (trust?.name !== undefined) {
    const nameLine = document.createElement('p')
    nameLine.className = 'name-line'
    nameLine.textContent = trust.name.line
    container.append(nameLine)
  }

  container.append(document.createElement('hr'))

  if (info.capabilityRows.length === 0 && permissions === null) {
    const empty = document.createElement('p')
    empty.className = 'empty-state'
    empty.textContent = isFile ? "This file hasn't been allowed to use Orivon permissions." : "This site hasn't asked for any permissions."
    container.append(empty)
  } else {
    const list = document.createElement('ul')
    list.className = 'row-list'
    for (const capRow of info.capabilityRows) {
      const on = staged.get(capRow.capability) ?? capRow.on
      const control = createSwitch(on, !capRow.on && !capRow.canTurnOn, (next) => { callbacks.onToggle(capRow.capability, next) })
      const li = row(capRow.capability, capRow.message, capRow.warning, control)
      if (pendingStaleCapabilities.has(capRow.capability)) {
        const note = document.createElement('span')
        note.className = 'row-note'
        note.textContent = "This app's request changed -- try again"
        li.append(note)
      }
      list.append(li)
    }
    container.append(list)
    // One press stages every held permission off; Confirm below applies it. The file stays recorded, so a later visit still finds its session.
    if (isFile && info.capabilityRows.some((capRow) => capRow.on)) {
      const turnOff = document.createElement('button')
      turnOff.type = 'button'
      turnOff.id = 'turn-off-local-file'
      turnOff.className = 'btn-secondary'
      turnOff.textContent = 'Turn off'
      turnOff.addEventListener('click', () => { for (const capRow of info.capabilityRows) if (capRow.on) callbacks.onToggle(capRow.capability, false) })
      container.append(turnOff)
    }
  }

  if (permissions !== null) container.append(renderSitePermissions(permissions, callbacks.permissions))

  if (staged.size > 0) {
    const anyOff = info.capabilityRows.some((r) => r.on && staged.get(r.capability) === false)
    const footer = document.createElement('div')
    footer.className = 'staged-footer'
    if (anyOff && info.consentGranularity !== 'per-capability') {
      const warn = document.createElement('p')
      warn.className = 'staged-warning'
      warn.textContent = 'This app asked for these together; turning one off may break it.'
      footer.append(warn)
    }
    const buttons = document.createElement('div')
    buttons.className = 'staged-buttons'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'btn-secondary'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', callbacks.onCancel)
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'btn-primary'
    confirm.textContent = 'Confirm'
    confirm.addEventListener('click', callbacks.onConfirm)
    buttons.append(cancel, confirm)
    footer.append(buttons)
    container.append(footer)
  } else if (showReloadBanner) {
    const banner = document.createElement('div')
    banner.className = 'reload-banner'
    const text = document.createElement('span')
    text.textContent = 'Reload this page to apply updated settings.'
    const reload = document.createElement('button')
    reload.type = 'button'
    reload.className = 'btn-primary'
    reload.textContent = 'Reload'
    reload.addEventListener('click', callbacks.onReload)
    banner.append(text, reload)
    container.append(banner)
  }

  if (info.pickedPathRows.length > 0) {
    container.append(document.createElement('hr'))
    const picksHeading = document.createElement('p')
    picksHeading.className = 'section-heading'
    picksHeading.textContent = 'Files and folders picked'
    container.append(picksHeading)
    const picks = document.createElement('ul')
    picks.className = 'row-list'
    for (const pick of info.pickedPathRows) {
      const control = createSwitch(true, false, () => { callbacks.onRevokePickedPath(pick.pickId) })
      picks.append(row(pick.kind, pick.message, pick.warning, control))
    }
    container.append(picks)
  }

  // The extensions disclosure (docs/planning/extensions-exploration.md): which
  // installed extensions' host access also reaches this origin. Hidden
  // when empty -- an ordinary site with no extensions installed shows
  // nothing here, matching every other optional section on this page.
  if (info.extensionsOnSite.length > 0) {
    container.append(document.createElement('hr'))
    const extensionsHeading = document.createElement('p')
    extensionsHeading.className = 'section-heading'
    extensionsHeading.textContent = 'Extensions on this site'
    container.append(extensionsHeading)
    const extensionsNames = document.createElement('p')
    extensionsNames.className = 'extensions-names'
    extensionsNames.textContent = info.extensionsOnSite.join(', ')
    container.append(extensionsNames)
    const manageRow = document.createElement('button')
    manageRow.type = 'button'
    manageRow.className = 'nav-row'
    const manageLabel = document.createElement('span')
    manageLabel.textContent = 'Manage'
    manageRow.append(manageLabel, chevronIcon())
    manageRow.addEventListener('click', callbacks.onManageExtensions)
    container.append(manageRow)
  }

  container.append(document.createElement('hr'))

  const dataRow = document.createElement('button')
  dataRow.type = 'button'
  dataRow.className = 'nav-row'
  const dataLabel = document.createElement('span')
  dataLabel.textContent = 'Cookies and site data'
  dataRow.append(dataLabel, chevronIcon())
  dataRow.addEventListener('click', callbacks.onOpenData)
  container.append(dataRow)

  const allSitesRow = document.createElement('button')
  allSitesRow.type = 'button'
  allSitesRow.className = 'nav-row'
  const allSitesLabel = document.createElement('span')
  allSitesLabel.textContent = 'Site settings'
  allSitesRow.append(allSitesLabel, chevronIcon())
  allSitesRow.addEventListener('click', callbacks.onOpenSiteSettings)
  container.append(allSitesRow)
}
