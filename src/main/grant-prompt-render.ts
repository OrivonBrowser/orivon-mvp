// Turns one (origin, manifest, capability, patterns) grant decision into
// the exact words a person reads before approving it -- item 4.2's whole
// deliverable (docs/planning/unattended-build-queue.md, owner decision 8).
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

import type { CapabilityKind, Manifest, Pattern } from '../contracts/index.js'

export interface GrantPromptContent {
  /** Drives `dialog.showMessageBox`'s own `type` -- a second, non-text
   * signal that a wide grant looks different, not just reads different. */
  readonly warning: boolean
  /** The dialog's title bar: the ORIGIN, never the app's self-asserted
   * `manifest.name` (capability-api.ts: origin is the real isolation key,
   * name is merely claimed). */
  readonly title: string
  /** The one-line headline a person reads first. */
  readonly message: string
  /** Secondary text: the app's claimed name, plus the plain-language
   * consequence of a breadth warning, when there is one. */
  readonly detail: string
}

const WARNING_HEADLINE = '⚠ Unlimited network access'

/** The one literal pattern this module treats as UNLIMITED, matching
 * manifest.ts's own doc for `TcpCapability.connect`/`HttpsCapability.
 * connect`/`UdpCapability.send`: host and port both `*`. */
function isUnlimited (patterns: readonly Pattern[]): boolean {
  return patterns.includes('*:*')
}

function hostFromPattern (pattern: Pattern): string {
  const idx = pattern.lastIndexOf(':')
  return idx === -1 ? pattern : pattern.slice(0, idx)
}

// Matches the owner's own example register ("Connect to youtube.com and 3
// other sites", d-0027): name the first host, count the rest, never list
// every one -- that reads as noise, not clarity, once an app declares more
// than a handful.
function namedHostsPhrase (verb: string, singular: string, plural: string, patterns: readonly Pattern[]): string {
  const hosts = Array.from(new Set(patterns.map(hostFromPattern)))
  if (hosts.length === 0) return `${verb} -- no hosts declared`
  if (hosts.length === 1) return `${verb} ${hosts[0]}`
  const rest = hosts.length - 1
  return `${verb} ${hosts[0]} and ${rest} other ${rest === 1 ? singular : plural}`
}

function portsPhrase (patterns: readonly Pattern[]): string {
  return patterns.length === 1 ? `port ${patterns[0]}` : `ports ${patterns.join(', ')}`
}

interface Rendered {
  readonly warning: boolean
  readonly message: string
  /** Present only alongside `warning: true` -- the sentence explaining
   * what "unlimited" actually means for this capability. */
  readonly explanation?: string
}

// `tcp.listen`/`udp.bind` never reach the unlimited branch: the contract
// itself rejects a bare `"*"` port range (manifest.ts), so there is no
// breadth case here to render -- only which ports.
function render (capability: CapabilityKind, patterns: readonly Pattern[]): Rendered {
  switch (capability) {
    case 'tcp.connect':
      return isUnlimited(patterns)
        ? { warning: true, message: WARNING_HEADLINE, explanation: 'This app can connect to any computer on the internet, not just specific ones.' }
        : { warning: false, message: namedHostsPhrase('Connect to', 'computer', 'computers', patterns) }
    case 'https.connect':
      return isUnlimited(patterns)
        ? { warning: true, message: WARNING_HEADLINE, explanation: 'This app can connect to any website, not just specific ones.' }
        : { warning: false, message: namedHostsPhrase('Connect to', 'site', 'sites', patterns) }
    case 'udp.send':
      return isUnlimited(patterns)
        ? { warning: true, message: WARNING_HEADLINE, explanation: 'This app can send data to any computer on the internet, not just specific ones.' }
        : { warning: false, message: namedHostsPhrase('Send data to', 'computer', 'computers', patterns) }
    case 'tcp.listen':
      return { warning: false, message: `Accept incoming connections on ${portsPhrase(patterns)}` }
    case 'udp.bind':
      return { warning: false, message: `Receive data on ${portsPhrase(patterns)}` }
    case 'fs':
      return { warning: false, message: 'Access files in a folder you choose' }
    case 'id':
      return { warning: false, message: 'Create a digital identity for you to use with this app' }
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
  const { warning, message, explanation } = render(capability, patterns)
  const claim = `Claims to be "${manifest.name}".`
  return {
    warning,
    title: origin,
    message,
    detail: explanation === undefined ? claim : `${claim} ${explanation}`
  }
}
