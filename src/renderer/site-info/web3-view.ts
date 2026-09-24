import type { SiteTrust } from '../../main/browsing/site-trust.js'
import type { DdocVerdict } from '../../trust/ddoc.js'
import type { DeliveryRung } from '../../trust/delivery-ladder.js'
import { backIcon } from './icons.js'

// The Web3 Score page: delivery evidence only, rendered as rung chips and
// plain facts -- never a number or letter (ADR-0006, ARCHITECTURE.md's
// "trust is shown as observed behaviour, never as a grade"). Connections
// and operations render as grey "Not observed yet": the broker keeps no
// connection log yet (src/trust/README.md), and claiming otherwise would
// be exactly the overclaim this page exists to prevent.

const RUNG_LABELS: Record<DeliveryRung, string> = {
  D1: 'Fetched from a host on every load',
  D2: 'Fetched once, cached, hash-pinned',
  D3: 'Content-addressed (infohash or CID)',
  D4: 'Content-addressed, name resolved trustlessly'
}

function bundleHashShort (hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`
}

// Says only what was compared. The anchor is the site's own host, so a
// match is never worded as proof of who owns the domain (ADR-0029).
function ddocLabel (ddoc: DdocVerdict): string {
  switch (ddoc.status) {
    case 'not-checked': return 'Not checked: this site is not installed'
    case 'not-published': return 'Not published by this site'
    case 'verified': return 'Files match the hash tree this site publishes (same host)'
    case 'failed': {
      if (ddoc.differingCount === 0) return 'Failed: the published hash tree contradicts its own root'
      const more = ddoc.differingCount > ddoc.differing.length ? ', …' : ''
      return `Failed: ${String(ddoc.differingCount)} file(s) differ from what this site publishes: ${ddoc.differing.join(', ')}${more}`
    }
  }
}

export function renderWeb3Page (container: HTMLElement, trust: SiteTrust | null, onBack: () => void): void {
  container.replaceChildren()

  const backRow = document.createElement('button')
  backRow.type = 'button'
  backRow.className = 'back-row'
  backRow.append(backIcon())
  const backLabel = document.createElement('span')
  backLabel.textContent = 'Web3 Score'
  backRow.append(backLabel)
  backRow.addEventListener('click', onBack)
  container.append(backRow)

  if (trust === null) {
    const empty = document.createElement('p')
    empty.className = 'empty-state'
    empty.textContent = 'Not available for this page.'
    container.append(empty)
    return
  }

  const rungList = document.createElement('ul')
  rungList.className = 'rung-list'
  for (const { rung, met } of trust.delivery.rungs) {
    const li = document.createElement('li')
    li.className = `rung ${met ? 'met' : 'unmet'}`
    const badge = document.createElement('span')
    badge.className = 'rung-badge'
    badge.textContent = rung
    const label = document.createElement('span')
    label.className = 'rung-label'
    label.textContent = RUNG_LABELS[rung]
    li.append(badge, label)
    rungList.append(li)
  }
  container.append(rungList)

  if (trust.pin !== undefined) {
    container.append(document.createElement('hr'))
    const evidence = document.createElement('dl')
    evidence.className = 'evidence-list'
    const rows: Array<[string, string]> = [
      ['Bundle hash', bundleHashShort(trust.pin.bundleHash)],
      ['Version', trust.pin.version],
      ['Pinned', new Date(trust.pin.pinnedAt).toLocaleString()],
      ['DDOC', ddocLabel(trust.ddoc)]
    ]
    const coverage = trust.delivery.evidence.pinCoverage
    if (coverage !== undefined) {
      const total = coverage.pinnedRequests + coverage.thirdPartyRequests
      rows.push(['Pin coverage', total === 0 ? 'No requests observed yet' : `${coverage.pinnedRequests} of ${total} requests from the pinned bundle`])
    }
    for (const [term, value] of rows) {
      const dt = document.createElement('dt')
      dt.textContent = term
      const dd = document.createElement('dd')
      dd.textContent = value
      evidence.append(dt, dd)
    }
    container.append(evidence)
  }

  container.append(document.createElement('hr'))

  const unknown = document.createElement('dl')
  unknown.className = 'evidence-list unknown'
  const unknownRows: Array<[string, string]> = [['Connections', 'Not observed yet'], ['Operations', 'Not observed yet']]
  if (trust.pin === undefined) unknownRows.unshift(['DDOC', ddocLabel(trust.ddoc)])
  for (const [term, value] of unknownRows) {
    const dt = document.createElement('dt')
    dt.textContent = term
    const dd = document.createElement('dd')
    dd.textContent = value
    unknown.append(dt, dd)
  }
  container.append(unknown)

  const disclaimer = document.createElement('p')
  disclaimer.className = 'disclaimer'
  disclaimer.textContent = 'Observed by this browser, never guaranteed.'
  container.append(disclaimer)
}
