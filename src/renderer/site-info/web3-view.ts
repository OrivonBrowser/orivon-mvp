import type { SiteTrust } from '../../main/browsing/site-trust.js'
import type { DdocVerdict } from '../../trust/ddoc.js'
import { backIcon } from './icons.js'

// The Web3 Score page. It leads with the Website level of the canonical Web3
// scores page, as far as this browser observes it: Level 1 or 2, decided by
// whether DDOC holds. Levels 3 and 4 are judgements only a Web3 Score
// provider may give, so they show as grey "?" and none is ever claimed --
// unless a developer-only override (`../../main/dev/score-levels.ts`) stands
// in for one, always named as an override, never as observed or judged
// (ADR-0006). Beneath the level sits the evidence it rests on: a `.eth`
// name's chain, the Delivery level (the same automatic-vs-override split,
// on the canonical Connection-to-network scale), the pin. Connections and
// operations render as grey "Not observed yet": the broker keeps no
// connection log (src/trust/README.md), and claiming otherwise would be
// exactly the overclaim this page exists to prevent.
//
// "Delivery" keeps that name rather than "Connection", which
// `../../trust/connection-ladder.ts` already owns for a different,
// still-unwired per-app axis (the "Connections: Not observed yet" row
// below) -- see that module's own header.

/** The canonical meanings, summarised: docs.orivonstack.com/docs/implementations/web3-score. */
const LEVEL_LABELS = [
  'Standard website (Web2)',
  'DDOC: its files match what its owner published',
  'Its own code is open source and runs nothing external without consent',
  'Trustless in every operation and connection'
] as const

/** The canonical Connection-to-network meanings, summarised the same way. */
const DELIVERY_LABELS = [
  'Relies on a trusted, centralised party for the bytes',
  'A proven .eth name, its content checked against that name\'s CID',
  'Trustless for data availability'
] as const

const SCORES_PAGE = 'docs.orivonstack.com/docs/implementations/web3-score'

function bundleHashShort (hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`
}

function rungItem (badgeText: string, labelText: string, state: 'met' | 'unmet' | 'unknown', levelClass?: string): HTMLLIElement {
  const li = document.createElement('li')
  const metLevel = state === 'met' && levelClass !== undefined ? ` ${levelClass}` : ''
  li.className = `rung ${state}${metLevel}`
  const badge = document.createElement('span')
  badge.className = `rung-badge${metLevel}`
  badge.textContent = badgeText
  const label = document.createElement('span')
  label.className = 'rung-label'
  label.textContent = labelText
  li.append(badge, label)
  if (state === 'unknown') {
    const mark = document.createElement('span')
    mark.className = 'rung-mark'
    mark.textContent = '?'
    li.append(mark)
  }
  return li
}

/** `n`'s state on a scale that tops out at `automaticMax` without an
 * override: automatically knowable rungs (`n <= automaticMax`) are a plain
 * met/unmet fact; anything past that is 'unknown' (grey "?") unless
 * `displayed` -- the observed level, or an override -- reaches that far. */
function rungState (n: number, displayed: number, automaticMax: number): 'met' | 'unmet' | 'unknown' {
  if (n <= displayed) return 'met'
  return n <= automaticMax ? 'unmet' : 'unknown'
}

function evidenceList (rows: ReadonlyArray<readonly [string, string]>, extraClass = ''): HTMLDListElement {
  const list = document.createElement('dl')
  list.className = `evidence-list${extraClass === '' ? '' : ` ${extraClass}`}`
  for (const [term, value] of rows) {
    const dt = document.createElement('dt')
    dt.textContent = term
    const dd = document.createElement('dd')
    dd.textContent = value
    list.append(dt, dd)
  }
  return list
}

function paragraph (className: string, text: string): HTMLParagraphElement {
  const p = document.createElement('p')
  p.className = className
  p.textContent = text
  return p
}

function levelSection (trust: SiteTrust): HTMLElement[] {
  const { level, because, assessable } = trust.level
  const displayed = trust.displayedLevel
  const overridden = trust.levelOverride !== undefined
  const list = document.createElement('ul')
  list.className = 'rung-list level-list'
  LEVEL_LABELS.forEach((label, index) => {
    const n = index + 1
    list.append(rungItem(`L${String(n)}`, label, rungState(n, displayed, 2), `level-${String(n)}`))
  })
  const assessed = assessable === undefined
    ? 'Nothing: this page has neither a CID nor a bundle hash.'
    : `${assessable.kind === 'cid' ? 'CID' : 'Bundle hash'} ${assessable.value}`
  const becauseText = overridden ? `Observed by this browser: Level ${String(level)}. ${because}` : because
  const disclaimer = overridden
    ? `Level ${String(displayed)} is a developer override (ORIVON_SCORE_LEVELS_FILE): not observed, and no provider judged it.`
    : `Levels 3 and 4 need a Web3 Score provider, and none is configured. What the levels mean: ${SCORES_PAGE}`
  return [
    paragraph('section-heading', `Website level ${String(displayed)}`),
    list,
    paragraph('level-because', becauseText),
    paragraph('disclaimer', disclaimer),
    paragraph('assessable', `A provider would assess: ${assessed}`)
  ]
}

function deliverySection (trust: SiteTrust): HTMLElement[] {
  const displayed = trust.displayedDelivery
  const overridden = trust.deliveryOverride !== undefined
  const list = document.createElement('ul')
  list.className = 'rung-list delivery-list'
  DELIVERY_LABELS.forEach((label, index) => {
    const n = index + 1
    list.append(rungItem(`D${String(n)}`, label, rungState(n, displayed, 2), n === 1 ? 'level-1' : n === 2 ? 'level-3' : 'level-4'))
  })
  const disclaimer = overridden
    ? `Level D${String(displayed)} is a developer override (ORIVON_SCORE_LEVELS_FILE): not observed.`
    : 'D3 needs fetching peer-to-peer, which this browser does not yet do.'
  return [
    paragraph('section-heading', `Delivery level D${String(displayed)}`),
    list,
    paragraph('disclaimer', disclaimer)
  ]
}

// Says only what was compared. The anchor is the site's own host, so a
// match is never worded as proof of who owns the domain (ADR-0029). A
// `.eth` name's own anchor is its contenthash, shown in the Name rows
// instead.
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

  container.append(...levelSection(trust))

  if (trust.name !== undefined) {
    container.append(document.createElement('hr'), paragraph('section-heading', 'Name'))
    container.append(evidenceList(trust.name.rows.map((row) => [row.term, row.value] as const)))
  }

  container.append(document.createElement('hr'))
  container.append(...deliverySection(trust))

  if (trust.pin !== undefined) {
    container.append(document.createElement('hr'))
    const rows: Array<[string, string]> = [
      ['Bundle hash', bundleHashShort(trust.pin.bundleHash)],
      ['Version', trust.pin.version],
      ['Pinned', new Date(trust.pin.pinnedAt).toLocaleString()]
    ]
    if (trust.name === undefined) rows.push(['DDOC', ddocLabel(trust.ddoc)])
    const coverage = trust.delivery.evidence.pinCoverage
    if (coverage !== undefined) {
      const total = coverage.pinnedRequests + coverage.thirdPartyRequests
      rows.push(['Pin coverage', total === 0 ? 'No requests observed yet' : `${coverage.pinnedRequests} of ${total} requests from the pinned bundle`])
    }
    container.append(evidenceList(rows))
  }

  container.append(document.createElement('hr'))

  const unknownRows: Array<[string, string]> = [['Connections', 'Not observed yet'], ['Operations', 'Not observed yet']]
  if (trust.pin === undefined && trust.name === undefined) unknownRows.unshift(['DDOC', ddocLabel(trust.ddoc)])
  container.append(evidenceList(unknownRows, 'unknown'))

  container.append(paragraph('disclaimer', 'Observed by this browser, never guaranteed.'))
}
