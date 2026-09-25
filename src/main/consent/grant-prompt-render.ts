// Turns one (origin, manifest, capability, patterns) grant decision into
// the exact words a person reads before approving it -- item 4.2's whole
// deliverable (.claude/unattended-build-queue.md, owner decision 8).
// Pure and I/O-free on purpose: request-grant-prompt.ts owns showing this
// content in a real dialog; this file owns only what it SAYS, so it is
// unit-tested against real Manifest values with no Electron process.
//
// THE EXIT CRITERION IS VISUAL CONTRAST, NOT ACCURACY ALONE: a narrow
// declaration and an unlimited one must be unmistakably different at a
// glance -- `warning` (drives the dialog's own icon) plus a literal
// "Unlimited" marker in the text, never a computed score or a detail a
// person has to expand to see (both considered and rejected -- see this
// lane's PR body).
//
// EVERY PATTERN IS RENDERED FROM THE PARSED FORM (../broker/policy/connect-
// patterns.js), NEVER A SECOND GUESS AT THE RAW STRING -- see this
// directory's README (Design notes) for why that is the fix itself, not a
// style choice (R2-01/AR-05).

import type { CapabilityKind, Manifest, Pattern } from '../../contracts/index.js'
import type { CapabilityGrantSummary } from './grant-prompt-connect.js'
import { describeConnectCapability, portsPhrase } from './grant-prompt-connect.js'
import { patternSetFromCapabilities } from '../../broker/policy/manifest-patterns.js'
import type { PatternSet } from '../../broker/policy/update.js'
import { formatOriginForDisplay } from './grant-prompt-origin.js'
// Re-exported so every existing caller and test keeps its import path (this
// split moved code, never an interface).
export { formatOriginForDisplay }

export type { CapabilityGrantSummary } from './grant-prompt-connect.js'

export interface GrantPromptContent {
  /** Drives `dialog.showMessageBox`'s own `type` -- a second, non-text
   * signal that a wide grant looks different, not just reads different. */
  readonly warning: boolean
  /** The dialog's title bar: the ORIGIN, never the app's self-asserted
   * `manifest.name` (capability-api.ts: origin is the real isolation key,
   * name is merely claimed). Electron's own `MessageBoxOptions.title` doc
   * says plainly "some platforms will not show it" -- so the origin is
   * ALSO the LAST line of `detail` (AR-01), which carries no such
   * caveat. A platform that drops the title still shows who is asking,
   * as the final thing read before the buttons. Passed through
   * `formatOriginForDisplay` first (A115) -- the SAME string `detail`'s
   * last line uses, so whichever field a platform actually renders says
   * the same thing. */
  readonly title: string
  /** The one-line headline a person reads first. */
  readonly message: string
  /** Secondary text, owner decision 2026-09-14: the app's claimed name on
   * its own line first (AR-03 -- never blended into the same sentence as
   * Orivon's own words, where 200 characters of ordinary app-chosen text
   * could fabricate a reassurance), then the plain-language consequence
   * of a breadth warning, when there is one, then the origin again
   * (AR-01) as the LAST line -- the one fact here a scam app cannot fake,
   * placed where a hurried reader's eye lands right before the buttons
   * rather than right under the name that can be faked. */
  readonly detail: string
}

/**
 * ADR-0019's `web.context`. AT THE WARNING LEVEL OF `tcp.listen`
 * (unconditional, never folded into a count): every granted origin gets its
 * OWN LINE, literally -- never "site.example and N others". Unlike an
 * ordinary `https.connect` host a person can skim past, "this app can act
 * AS this site" is exactly the fact A197's own sensitive-address handling
 * (grant-prompt-connect.ts) already argues cannot be folded away, applied
 * here to every origin this capability ever names. Wording is the ADR's own
 * (its Reasoning section: "The prompt can say it honestly and plainly").
 */
function describeWebContextGrant (patterns: readonly Pattern[]): CapabilityGrantSummary {
  const hosts = patterns.map((origin) => {
    try {
      return new URL(origin).host
    } catch {
      // Never reached for a genuinely granted pattern -- manifest-
      // capabilities.ts's readWeb already rejects anything that is not a
      // real URL before a grant naming it can exist. The raw string is the
      // safe fallback for a hand-edited or corrupted persisted grant
      // (permissions.ts's own buildPersistedAppPermissions reads these off
      // disk without re-validating them).
      return origin
    }
  })
  return {
    warning: true,
    message: hosts.map((host) => `⚠ Run code as ${host}, in a private, empty session.`).join('\n'),
    explanation: 'It cannot see your account or anything you keep there.'
  }
}

// `tcp.listen`/`udp.bind` never reach a wildcard-host branch: the contract
// itself rejects a bare `"*"` port range (manifest.ts), and a listen/bind
// pattern has no host at all -- only which ports.
export function describeCapabilityGrant (capability: CapabilityKind, patterns: readonly Pattern[]): CapabilityGrantSummary {
  switch (capability) {
    case 'tcp.connect':
      return describeConnectCapability(
        'Connect to', 'computer', 'computers',
        'This app can connect to any computer on the internet, not just specific ones.',
        patterns
      )
    case 'https.connect':
      return describeConnectCapability(
        'Connect to', 'site', 'sites',
        'This app can connect to any website, not just specific ones.',
        patterns
      )
    case 'udp.send':
      return describeConnectCapability(
        'Send data to', 'computer', 'computers',
        'This app can send data to any computer on the internet, not just specific ones.',
        patterns
      )
    // A134: listening is a materially different act from connecting out --
    // the manifest's own doc comment (TcpCapability.listen) promises this a
    // "distinct, more serious prompt", and capability-api.md's open item 1
    // requires it unconditionally, not only past some port-breadth
    // threshold: `'*'` is already rejected for a listen pattern, so there
    // is no "narrow" listen grant the way a single named host is a narrow
    // connect grant. warning: true always, matching describeRollbackChoice's
    // own unconditional case for the same reason -- every instance is the
    // same shape of risk.
    case 'tcp.listen':
      return {
        warning: true,
        message: `⚠ Accept incoming connections on ${portsPhrase(patterns)}`,
        explanation: 'This opens a door into your device: any other computer that can reach this port -- on your network, or the internet if it is forwarded -- can connect to this app, not only computers it reached out to first.'
      }
    case 'udp.bind':
      return {
        warning: true,
        message: `⚠ Receive data on ${portsPhrase(patterns)}`,
        explanation: 'This opens a door into your device: any other computer that can reach this port -- on your network, or the internet if it is forwarded -- can send this app data, not only computers it contacted first.'
      }
    // Not merged with udp.bind here -- that merge only makes sense when a
    // single request names BOTH (a real P2P app's normal shape: one port
    // range, two protocols), and this function renders exactly one
    // capability at a time, including for the settings permissions list
    // (../permissions.ts), where each live grant is its own revocable row
    // and must stay that way. describeCapabilitySet's own mergeInboundRows
    // is where the combined case lives.
    case 'fs':
      // AR-04: `fs.userSelected` and a folder picker are unbuilt (queue item
      // 4.3). What a grant actually gives today is an app-private directory
      // the broker roots and confines -- say that, not a mechanism ("a
      // folder you choose") that does not exist and creates a specific
      // false expectation.
      return { warning: false, message: 'Store files in a private folder for this app on this device' }
    case 'id':
      return { warning: false, message: 'Create a digital identity for you to use with this app' }
    case 'web.context':
      return describeWebContextGrant(patterns)
    default: {
      // Exhaustiveness guard, matching app-install.ts's own pattern: a new
      // CapabilityKind added without a case here fails to compile.
      const exhaustive: never = capability
      throw new Error(`grant-prompt-render: unhandled capability kind ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * The full rendering for one grant decision. `manifest` is fetched by the
 * caller (request-grant-prompt.ts) -- this function never does I/O, so it
 * can be tested directly against real `Manifest` values, including ones
 * declaring several capabilities at once; only the one named by
 * `capability` is ever rendered from it.
 */
export function describeGrantRequest (
  origin: string,
  manifest: Manifest,
  capability: CapabilityKind,
  patterns: readonly Pattern[]
): GrantPromptContent {
  const { warning, message, explanation } = describeCapabilityGrant(capability, patterns)
  // A115: rendered once here, reused for both `title` and `detail`'s last
  // line below -- never the raw origin twice over, which is how a
  // subdomain-prefix confusable used to survive.
  const displayOrigin = formatOriginForDisplay(origin)
  // AR-03: the app's claimed name gets its OWN line, never concatenated
  // into the same sentence as Orivon's explanation -- a `manifest.name`
  // crafted to look like a sentence ending (`Weather App". This app only
  // connects to weather.example. Claims to be "Weather App`) stays
  // visually bounded to its own line instead of blending into text Orivon
  // actually wrote. `manifest.name` can never contain a literal newline
  // (manifest.ts's `UNSAFE_TEXT_CHARS` rejects control characters,
  // including `\n`/`\r`, at parse time), so only this template -- never
  // the app -- can introduce a line break here.
  //
  // Owner decision, 2026-09-14: the origin goes LAST, after the claim and
  // its explanation, not first -- AR-01 still puts it in a field Electron
  // never drops (unlike `title`), but now as the final line a person
  // reads before the dialog's buttons, since it is the one line here an
  // app cannot fabricate.
  const claim = `Claims to be "${manifest.name}".`
  const detailLines = [claim]
  if (explanation !== undefined) detailLines.push(explanation)
  detailLines.push(displayOrigin)
  return {
    warning,
    title: displayOrigin,
    message,
    detail: detailLines.join('\n')
  }
}

/**
 * `tcp.listen` and `udp.bind` together, as one row -- a real P2P app (a
 * torrent client, say) declares both for the SAME reason, one port range
 * doing peer connections over TCP and DHT/exchange over UDP, and rendering
 * them as two separately-warned rows says the same underlying fact
 * ("other computers can reach this device") twice in different words. Only
 * called when a single request names BOTH; either alone still renders
 * through `describeCapabilityGrant`'s own case, unmerged, exactly as
 * before (the settings permissions list, ../permissions.ts, always calls
 * that path and never this one -- see the comment on the `udp.bind` case
 * above).
 */
function describeInboundAccess (listenPatterns: readonly Pattern[], bindPatterns: readonly Pattern[]): CapabilityGrantSummary {
  const samePorts = listenPatterns.length === bindPatterns.length &&
    listenPatterns.every((pattern, index) => pattern === bindPatterns[index])
  const portsText = samePorts
    ? `on ${portsPhrase(listenPatterns)}`
    : `on ${portsPhrase(listenPatterns)} (TCP) and ${portsPhrase(bindPatterns)} (UDP)`
  return {
    warning: true,
    message: `⚠ Accepts connections and data from other computers ${portsText}`,
    explanation: 'This opens a door into your device: any other computer that can reach these ports -- on your network, or the internet if they are forwarded -- can connect to or send data to this app, not only computers this app contacted first.'
  }
}

/**
 * Collapses rows that render the IDENTICAL headline into one, unioning
 * their explanations -- the fix for the other half of the same redundancy
 * `describeInboundAccess` targets. `tcp.connect: ["*:*"]` and
 * `udp.send: ["*:*"]` both produce the literal string `WARNING_HEADLINE`
 * with DIFFERENT explanations; shown as two rows, an identical headline
 * repeated reads as a rendering bug, not as two facts. Order-preserving --
 * the merged row appears where its first contributor did, so `fs`/`id`
 * rows are never reordered around it -- and general on purpose: it fires
 * for any two capabilities that happen to share a headline, not only this
 * pair, without either capability needing to know about the other.
 */
function mergeRowsWithIdenticalMessage (rows: readonly CapabilityGrantSummary[]): readonly CapabilityGrantSummary[] {
  const merged: CapabilityGrantSummary[] = []
  for (const row of rows) {
    const at = merged.findIndex((seen) => seen.message === row.message)
    const existing = at === -1 ? undefined : merged[at]
    if (existing === undefined) {
      merged.push(row)
      continue
    }
    const explanations = Array.from(new Set([existing.explanation, row.explanation].filter((value): value is string => value !== undefined)))
    const combined = { warning: existing.warning || row.warning, message: existing.message }
    merged[at] = explanations.length > 0 ? { ...combined, explanation: explanations.join(' ') } : combined
  }
  return merged
}

/**
 * The shared body behind `describeInstallConsent` and S4-5's
 * `describeCapabilityPrompt`: one dialog listing several capabilities at
 * once, each rendered through `describeCapabilityGrant` -- never a second
 * vocabulary (Rule 3). Only the headline `message` differs between the two
 * callers; everything else (the per-row rendering, the origin/claim lines,
 * the warning icon) is one implementation.
 *
 * BREADTH STAYS VISIBLE PER ROW, not only once for the whole dialog: `warning`
 * (this dialog's own icon) is true the moment ANY row is unlimited, but each
 * unlimited row's own line still carries `describeCapabilityGrant`'s literal
 * "Unlimited" marker and explanation -- so a narrow row sitting next to a
 * wide one still reads as narrow, and the wide one still stands out on its
 * own line, not only through an icon a person may not consciously register.
 *
 * TWO MERGES RUN BEFORE RENDERING, both fixing REDUNDANT rows rather than
 * TRUE ones -- found against the torrent example manifest (capability-api.md:
 * `connect: ["*:*"]` + `listen` + `udp.bind` + `send: ["*:*"]` + `fs`),
 * which rendered 4 of 5 rows warned and one headline twice. Neither merge silences a real
 * warning: `tcp.listen`+`udp.bind` become one row (`describeInboundAccess`)
 * because they are one fact stated twice, and any two rows that render the
 * identical headline collapse into one (`mergeRowsWithIdenticalMessage`)
 * for the same reason. What is left after both is exactly as many warned
 * rows as there are DISTINCT kinds of breadth the manifest actually
 * declares -- for that manifest, two: it can reach anywhere outbound, and it
 * can be reached from anywhere inbound. Considered and rejected: a second,
 * lower-severity marker for `tcp.listen`/`udp.bind` (README, Design notes)
 * -- the two facts are not degrees of the same risk, so grading one below
 * the other would misstate it rather than declutter it.
 */
function describeCapabilitySet (
  origin: string,
  manifest: Manifest,
  declared: PatternSet,
  capabilities: readonly CapabilityKind[],
  message: string,
  held: readonly CapabilityKind[]
): GrantPromptContent {
  const mergeInbound = capabilities.includes('tcp.listen') && capabilities.includes('udp.bind')
  let inboundRowEmitted = false
  const rows: CapabilityGrantSummary[] = []
  // Parallel to `rows`, index for index: which declared capability (or,
  // for the merged inbound row, BOTH capabilities) produced that row --
  // A170 needs this to know whether a row is fully covered by `held`,
  // after merging may have combined it with a row that started from a
  // DIFFERENT capability.
  const rowCapabilities: Array<readonly CapabilityKind[]> = []
  for (const capability of capabilities) {
    const isInboundCapability = capability === 'tcp.listen' || capability === 'udp.bind'
    if (mergeInbound && isInboundCapability) {
      if (inboundRowEmitted) continue
      inboundRowEmitted = true
      rows.push(describeInboundAccess(declared['tcp.listen'] ?? [], declared['udp.bind'] ?? []))
      rowCapabilities.push(['tcp.listen', 'udp.bind'])
      continue
    }
    rows.push(describeCapabilityGrant(capability, declared[capability] ?? []))
    rowCapabilities.push([capability])
  }
  const mergedRows = mergeRowsWithIdenticalMessage(rows)
  const warning = mergedRows.some((row) => row.warning)

  const displayOrigin = formatOriginForDisplay(origin)
  const claim = `Claims to be "${manifest.name}".`
  // A170 (CRITICAL): a row is marked only when EVERY capability that
  // contributed to it (recovered by matching on `message`, the same key
  // mergeRowsWithIdenticalMessage itself merges on) is already held -- a
  // row combining a held capability with a not-yet-decided one still reads
  // as something Deny genuinely affects. Wording matches
  // describeCapabilityChoice's own `[Allowed]`/`[Denied]` bracket
  // convention (grant-prompt-choice.ts) rather than inventing a second one.
  const rowLines = mergedRows.map((row) => {
    const contributing = rowCapabilities.filter((_, index) => rows[index]?.message === row.message).flat()
    const isHeld = contributing.length > 0 && contributing.every((capability) => held.includes(capability))
    const marker = isHeld ? '[Already allowed] ' : ''
    return row.explanation === undefined ? `- ${marker}${row.message}` : `- ${marker}${row.message}\n  ${row.explanation}`
  })

  // Owner decision, 2026-09-14: the origin closes `detail`, after the
  // claim and every capability row, rather than opening it -- see the
  // matching comment on `describeGrantRequest`.
  return {
    warning,
    title: displayOrigin,
    message,
    detail: [claim, ...rowLines, displayOrigin].join('\n')
  }
}

/**
 * d-0025 (ADR-0012's 2026-09-13 amendment) / queue item S4-4: one dialog for
 * the WHOLE set a manifest declares, asked once before the app's own code
 * runs -- never `describeGrantRequest`'s one-capability shape shown once per
 * declared capability, which is the fatigue that amendment exists to remove.
 *
 * `formatOriginForDisplay` and the origin/claim lines are exactly
 * `describeGrantRequest`'s own (A115, AR-01, AR-03), including the claim-
 * first, address-last order (owner decision 2026-09-14), so every dialog in
 * this file reads as one family, not several designs.
 *
 * `held` (A170) names whatever `capabilities` already holds through a
 * SEPARATE door (`app.requestGrant`) -- each such row is marked, so Deny
 * visibly does not cover it. Defaults to none, so every pre-existing caller
 * (including the per-capability overview, ./install-consent-prompt.ts)
 * keeps rendering exactly as before.
 */
export function describeInstallConsent (
  origin: string,
  manifest: Manifest,
  capabilities: readonly CapabilityKind[],
  held: readonly CapabilityKind[] = []
): GrantPromptContent {
  return describeCapabilitySet(origin, manifest, patternSetFromCapabilities(manifest.capabilities), capabilities, 'This app wants to:', held)
}

/**
 * S4-5's `needs-capability-prompt`: an ALREADY-INSTALLED app's update asks
 * for more than the person already agreed to. `requestedPatterns` is
 * `src/loader/index.ts`'s `LoadNeedsCapabilityPrompt.requestedPatterns` --
 * already the manifest's own full declared set (`update.ts`'s own doc:
 * capability-prompt "subsumes reconsent... re-establishes consent for the
 * app as it now is") -- so this renders every currently-declared
 * capability, the same complete-picture framing `describeInstallConsent`
 * uses at first install, under a headline that says plainly this is more
 * than what was already approved rather than reusing "This app wants to:"
 * unchanged, which would read as a first ask.
 */
export function describeCapabilityPrompt (
  origin: string,
  manifest: Manifest,
  requestedPatterns: PatternSet
): GrantPromptContent {
  const capabilities = Object.keys(requestedPatterns) as readonly CapabilityKind[]
  // A170 is scoped to describeInstallConsent's own dialog -- this screen's
  // `capabilities` is already exactly what is being asked about here, so
  // there is no held-vs-outstanding distinction of the SAME kind to mark.
  return describeCapabilitySet(origin, manifest, requestedPatterns, capabilities, 'This app wants to do more than you already allowed:', [])
}

/**
 * S4-5's `needs-reconsent`: `decideUpdate()` reached this outcome BECAUSE
 * the granted pattern set does not change (`widensAuthority` returned
 * false) -- there is nothing for `describeCapabilityGrant` to render, only
 * the plain fact that the app's code changed and what it may do did not.
 */
export function describeReconsent (origin: string, manifest: Manifest): GrantPromptContent {
  const displayOrigin = formatOriginForDisplay(origin)
  const claim = `Claims to be "${manifest.name}".`
  // Owner decision, 2026-09-14: claim, then notice, then the address last --
  // same order as every other dialog in this file.
  return {
    warning: false,
    title: displayOrigin,
    message: 'This app has been updated.',
    detail: [claim, 'Its code has changed. What it is allowed to do has not.', displayOrigin].join('\n')
  }
}

/**
 * S4-5's `needs-rollback-choice` (`ADR-0013`): the origin is offering a
 * version below its own floor. `warning: true` unconditionally -- unlike a
 * capability grant, there is no narrow case here: every below-floor
 * offering is the same shape of risk (a genuine developer rollback, or old,
 * less-secure code being replayed) regardless of what the manifest
 * declares.
 */
export function describeRollbackChoice (origin: string, manifest: Manifest, versionFloor: string): GrantPromptContent {
  const displayOrigin = formatOriginForDisplay(origin)
  const claim = `Claims to be "${manifest.name}".`
  const notice = `You've used version ${versionFloor} or newer from this app before. It is now offering version ${manifest.version} -- an older one.`
  const risk = 'This can be a genuine rollback by the developer, or a sign that something is serving old, less secure code.'
  // Owner decision, 2026-09-14: claim, then both notices, then the address
  // last -- same order as every other dialog in this file.
  return {
    warning: true,
    title: displayOrigin,
    message: 'This app is offering an older version.',
    detail: [claim, notice, risk, displayOrigin].join('\n')
  }
}
