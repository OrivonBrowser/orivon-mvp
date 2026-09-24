import type { SiteInfo, SiteCapabilityRow } from '../../main/permissions/site-info.js'
import type { SiteTrust } from '../../main/browsing/site-trust.js'
import { createSwitch } from './switch.js'
import { shieldIcon, chevronIcon } from './icons.js'

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
  readonly onOpenAllSites: () => void
  readonly onReload: () => void
}

function connectionLabel (connection: SiteTrust['connection']): string {
  switch (connection) {
    case 'cached': return 'Running from local cache, pinned'
    case 'secure': return 'Connection is secure'
    case 'insecure': return 'Connection is not secure'
  }
}

/** One short line naming the observed Website level and the strongest
 * delivery rung; connections are never observed, so they stay `?`. */
function trustGlance (trust: SiteTrust | null): string {
  if (trust === null) return 'Web3 Score'
  const met = trust.delivery.rungs.filter((r) => r.met).map((r) => r.rung)
  const delivery = met.length > 0 ? met[met.length - 1] : 'D1'
  return `Web3 Score · Website L${String(trust.level.level)} · Delivery ${delivery} · Connections ?`
}

function row (message: string, warning: boolean, control: HTMLElement): HTMLElement {
  const li = document.createElement('li')
  li.className = 'row'
  li.classList.toggle('warning', warning)
  const text = document.createElement('span')
  text.className = 'row-message'
  text.textContent = message
  li.append(text, control)
  return li
}

export function renderMainPage (
  container: HTMLElement,
  info: SiteInfo,
  trust: SiteTrust | null,
  staged: ReadonlyMap<SiteCapabilityRow['capability'], boolean>,
  pendingStaleCapabilities: ReadonlySet<SiteCapabilityRow['capability']>,
  showReloadBanner: boolean,
  callbacks: MainPageCallbacks
): void {
  container.replaceChildren()

  const header = document.createElement('header')
  header.className = 'site-header'
  const origin = document.createElement('div')
  origin.className = 'site-origin'
  origin.textContent = info.displayOrigin
  header.append(origin)
  if (info.claimedName !== undefined) {
    const claim = document.createElement('div')
    claim.className = 'site-claim'
    claim.textContent = `Claims to be "${info.claimedName}".`
    header.append(claim)
  }
  container.append(header)

  const connectionRow = document.createElement('button')
  connectionRow.type = 'button'
  connectionRow.className = `connection-row ${trust?.connection ?? 'unknown'}`
  connectionRow.append(shieldIcon())
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

  if (trust?.name !== undefined) {
    const nameLine = document.createElement('p')
    nameLine.className = 'name-line'
    nameLine.textContent = trust.name.line
    container.append(nameLine)
  }

  container.append(document.createElement('hr'))

  if (info.capabilityRows.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'empty-state'
    empty.textContent = "This site hasn't asked for any permissions."
    container.append(empty)
  } else {
    const list = document.createElement('ul')
    list.className = 'row-list'
    for (const capRow of info.capabilityRows) {
      const on = staged.get(capRow.capability) ?? capRow.on
      const control = createSwitch(on, !capRow.on && !capRow.canTurnOn, (next) => { callbacks.onToggle(capRow.capability, next) })
      const li = row(capRow.message, capRow.warning, control)
      if (pendingStaleCapabilities.has(capRow.capability)) {
        const note = document.createElement('span')
        note.className = 'row-note'
        note.textContent = "This app's request changed -- try again"
        li.append(note)
      }
      list.append(li)
    }
    container.append(list)
  }

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
      picks.append(row(pick.message, pick.warning, control))
    }
    container.append(picks)
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
  allSitesRow.append(allSitesLabel)
  allSitesRow.addEventListener('click', callbacks.onOpenAllSites)
  container.append(allSitesRow)
}
