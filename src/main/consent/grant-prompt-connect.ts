// Split out of grant-prompt-render.ts (Rule 2: with its two row-merge
// functions, that file would cross 500 lines) along its own real seam:
// everything about turning a HOST:PORT PATTERN LIST into a sentence -- the
// wildcard check, port breadth, the large-host-set warning (A133) -- versus
// that file's own concern, which is turning a whole CAPABILITY SET into one
// dialog. `describeCapabilityGrant`'s switch (grant-prompt-render.ts) calls
// `describeConnectCapability` for the three pattern-shaped capabilities and
// handles `tcp.listen`/`udp.bind`/`fs`/`id` itself, which have no patterns
// to parse this way.
//
// EVERY PATTERN IS RENDERED FROM THE PARSED FORM (../broker/policy/connect-
// patterns.js), NEVER A SECOND GUESS AT THE RAW STRING -- see this
// directory's README (Design notes) for why that is the fix itself, not a
// style choice (R2-01/AR-05).

import type { Pattern } from '../../contracts/index.js'
import { MAX_PORT, normalizeHost } from '../../broker/policy/canonical-host.js'
import { MAX_PATTERNS } from '../../broker/policy/connect.js'
import { hostSpecKind, parsePattern as parseConnectPattern, parsePortSpec } from '../../broker/policy/connect-patterns.js'
import { classifyAddress, isPublicUnicast, type AddressClass } from '../../broker/policy/address.js'

/**
 * One already-granted capability's plain-language summary -- exported for
 * the permissions list (queue item 4.4, `../permissions.ts`), which renders
 * one row per live `Grant` and needs exactly this fact, not a whole request
 * dialog's title/detail. `describeGrantRequest` (grant-prompt-render.ts) is
 * this function plus the claim/explanation framing a REQUEST prompt needs,
 * and the two must never drift into two separate wordings for the same
 * capability (code-guidelines.md Rule 3), so the list reuses this directly
 * rather than re-deriving its own copy of `describeCapabilityGrant`'s switch.
 */
export interface CapabilityGrantSummary {
  readonly warning: boolean
  readonly message: string
  /** Present only alongside `warning: true` -- the sentence explaining what
   * this row's warning actually means: unlimited reach, a host set too
   * large to weigh individually (A133), a listening/binding capability
   * accepting inbound traffic (A134), or a manifest pattern naming a
   * private/loopback/link-local address directly (A197). */
  readonly explanation?: string
}

const WARNING_HEADLINE = '⚠ Unlimited network access'

/** `port 443`, or `ports 22, 443, 5432` for more than one -- shared by
 * `tcp.listen`/`udp.bind`'s own rendering (grant-prompt-render.ts) and
 * connect breadth here (AR-02), rather than a second joiner. */
export function portsPhrase (patterns: readonly Pattern[]): string {
  return patterns.length === 1 ? `port ${patterns[0]}` : `ports ${patterns.join(', ')}`
}

/** One parsed `host:port` pattern, via the SAME grammar the runtime
 * matcher uses -- never a second guess at the string. A pattern the real
 * grammar cannot parse authorises nothing at connect time
 * (`connect-patterns.ts`'s own doc on `parsePattern`), so it contributes
 * nothing here either, rather than being rendered as if it were a host. */
interface ConnectPatternInfo {
  readonly host: string
  readonly port: string
  /** `hostSpecKind(host) === 'any-public-unicast'` -- true for a bare `'*'`
   * host REGARDLESS of the paired port (R2-01): the runtime matcher grants
   * reach to any public address on that basis alone. */
  readonly hostIsWildcard: boolean
  /** A197: non-null only for an ADDRESS-LITERAL pattern reaching
   * outside ordinary public unicast space (T12) -- the ONLY way such an
   * address becomes reachable at all (`hostMatches`, connect-patterns.ts:
   * a hostname never authorises a private address, even its own). Null for
   * an ordinary hostname and for a literal that IS public space, so both
   * keep rendering exactly as before. */
  readonly nonPublicAddressClass: AddressClass | null
}

/** `hostSpecKind(host) === 'address-literal'` and `isPublicUnicast` says no
 * -- the one shape `hostMatches` will actually honour for a private
 * address (an app-controlled hostname never resolves onto one, by
 * design). `isPublicUnicast` is the gate, reused rather than
 * reimplemented (code-guidelines.md Rule 3); `classifyAddress`, the same
 * file, supplies which class it is in for the wording below. */
function nonPublicAddressClassOf (host: string): AddressClass | null {
  if (hostSpecKind(host) !== 'address-literal') return null
  const address = normalizeHost(host)
  return isPublicUnicast(address) ? null : classifyAddress(address)
}

function parseConnectPatterns (patterns: readonly Pattern[]): readonly ConnectPatternInfo[] {
  const infos: ConnectPatternInfo[] = []
  for (const pattern of patterns) {
    const parsed = parseConnectPattern(pattern)
    if (parsed === null) continue
    infos.push({
      host: parsed.host,
      port: parsed.port,
      hostIsWildcard: hostSpecKind(parsed.host) === 'any-public-unicast',
      nonPublicAddressClass: nonPublicAddressClassOf(parsed.host)
    })
  }
  return infos
}

/** A197: plain language for an address class a manifest pattern named
 * directly -- the register `tcp.listen`/`udp.bind`'s own explanation uses
 * ("your device", "your network"), not a second vocabulary. Every class
 * `nonPublicAddressClassOf` can actually return gets a line here; the
 * exhaustiveness guard below is what makes a new `AddressClass` (`public`/
 * `unparseable` excluded by construction) a compile error instead of a
 * silent `undefined`. */
function describeAddressClass (cls: Exclude<AddressClass, 'public' | 'unparseable'>): string {
  switch (cls) {
    case 'loopback': return 'your own device'
    case 'private': return 'a computer on your local network'
    case 'link-local': return 'a device on your local network'
    case 'unspecified': return 'an unspecified address'
    case 'multicast': return 'a group of devices on your network'
    case 'broadcast': return 'every device on your network'
    case 'reserved': return 'a reserved address, not part of the ordinary internet'
    default: {
      const exhaustive: never = cls
      throw new Error(`grant-prompt-connect: unhandled address class ${JSON.stringify(exhaustive)}`)
    }
  }
}

/** A port spec that reaches every port a connection could ever name -- the
 * literal `'*'` wildcard, or a `lo-hi` range spanning the whole space
 * (`1-65535`). Both mean the same thing to a person reading a prompt, so
 * both read as "any port" rather than one looking narrower than the other
 * purely because of which digits its author happened to write. */
function coversAllPorts (portSpec: string): boolean {
  const parsed = parsePortSpec(portSpec)
  if (parsed === null) return false
  return parsed === 'any' || (parsed.lo === 1 && parsed.hi === MAX_PORT)
}

function isSinglePort (portSpec: string): boolean {
  const parsed = parsePortSpec(portSpec)
  return parsed !== null && parsed !== 'any' && parsed.lo === parsed.hi
}

/** `port 443`, or `any port` for a wildcard/full-range spec -- the same
 * shape `portsPhrase` renders, reused here for connect breadth (AR-02)
 * rather than a second joiner. */
function portsListPhrase (specs: readonly string[]): string {
  const unique = Array.from(new Set(specs))
  if (unique.length === 1) {
    const only = unique[0]
    if (only !== undefined && coversAllPorts(only)) return 'any port'
  }
  return portsPhrase(unique)
}

// A133, CORRECTED: a real 12-host feed-reader manifest tripped the first
// version of this threshold (10 OTHER hosts, chosen by a single-digit vs
// double-digit reading of English) -- proof the number was wrong, not just
// unproven, since twelve individually-named feeds is a narrow declaration
// by any sensible reading, not a breadth risk. Re-anchored on something a
// count of hosts can actually be compared against: `MAX_PATTERNS`, the real,
// already-enforced ceiling on how many patterns ONE capability's array may
// declare at all (loader/manifest/capabilities.ts). This fires only once a
// manifest names at least HALF of the hosts the format permits it to name
// -- comfortably above any curated, human-reviewable list (a feed reader,
// a CDN allowlist), and close enough to the format's own maximum that
// naming individual hosts has stopped being a meaningfully narrower
// declaration than not naming any. Presentation, not policy -- retune
// freely; see this directory's README, Design notes, for the full
// before/after and why a fraction of the real ceiling replaced the
// original digit-count reasoning rather than just picking a bigger guess.
const MANY_HOSTS_THRESHOLD = MAX_PATTERNS / 2

// Matches the owner's own example register ("Connect to youtube.com and 3
// other sites", d-0027): name the first host, count the rest, never list
// every one -- that reads as noise, not clarity, once an app declares more
// than a handful. Port breadth (AR-02) is shown only for a SINGLE named
// host: once there is more than one, the line is already "first host and N
// others" and stacking port detail on top of that would need the "details"
// expander D-0004 rejects by name -- this is a deliberate scope limit, not
// an oversight, and it does not hide anything the wildcard-host branch
// below is responsible for (that branch never calls this function at all).
function namedHostsSummary (verb: string, singular: string, plural: string, infos: readonly ConnectPatternInfo[]): CapabilityGrantSummary {
  const hosts = Array.from(new Set(infos.map((info) => info.host)))
  const first = hosts[0]
  if (first === undefined) return { warning: false, message: `${verb} -- no hosts declared` }

  if (hosts.length >= MANY_HOSTS_THRESHOLD) {
    // Same mechanism as the wildcard-host warning (warning + explanation),
    // never a second vocabulary -- but the count stays honest in the
    // explanation rather than being replaced by a vaguer word: the reader
    // gets both "this is too many to weigh" AND the true number.
    const lowerVerb = verb.charAt(0).toLowerCase() + verb.slice(1)
    return {
      warning: true,
      message: `⚠ ${verb} a large number of ${plural}`,
      explanation: `This app can ${lowerVerb} ${hosts.length} specific ${plural}, starting with ${first} -- more than can be weighed individually.`
    }
  }

  if (hosts.length === 1) {
    const ports = infos.filter((info) => info.host === first).map((info) => info.port)
    const uniquePorts = Array.from(new Set(ports))
    const onlyPort = uniquePorts[0]
    if (uniquePorts.length === 1 && onlyPort !== undefined && isSinglePort(onlyPort)) return { warning: false, message: `${verb} ${first}` }
    return { warning: false, message: `${verb} ${first} on ${portsListPhrase(uniquePorts)}` }
  }
  const rest = hosts.length - 1
  return { warning: false, message: `${verb} ${first} and ${rest} other ${rest === 1 ? singular : plural}` }
}

/**
 * A197: at least one declared host is a loopback/private/link-local/...
 * address literal. Every one is named explicitly and NEVER folded into
 * "and N other sites" -- unlike an ordinary public host, a person cannot
 * reasonably skim past "your own device" or "a computer on your network"
 * the way they can past a domain name, so hiding it behind a count is the
 * A197 defect itself, not a presentation shortcut. `warning: true`
 * unconditionally, matching `tcp.listen`/`udp.bind`'s own unconditional
 * case (A134): reaching a device on the person's own network is a
 * categorically different kind of grant than reaching an ordinary public
 * site, not a narrower version of the same one.
 *
 * Ordinary public hosts alongside a sensitive one still fold into a count
 * exactly as `namedHostsSummary` already does -- only the sensitive
 * addresses lose that treatment, because only they are the ones a person
 * cannot afford to skim past.
 */
function namedHostsSummaryWithSensitiveAddresses (verb: string, singular: string, plural: string, infos: readonly ConnectPatternInfo[]): CapabilityGrantSummary {
  const sensitive = infos.filter((info): info is ConnectPatternInfo & { nonPublicAddressClass: AddressClass } => info.nonPublicAddressClass !== null)
  const sensitiveHosts = Array.from(new Set(sensitive.map((info) => info.host)))
  const classByHost = new Map(sensitive.map((info) => [info.host, info.nonPublicAddressClass]))

  const ordinaryHosts = Array.from(new Set(
    infos.filter((info) => info.nonPublicAddressClass === null).map((info) => info.host)
  ))
  const otherSitesClause = ordinaryHosts.length === 0
    ? ''
    : ` and ${ordinaryHosts.length} other ${ordinaryHosts.length === 1 ? singular : plural}`

  const sentences = sensitiveHosts.map((host) => {
    const cls = classByHost.get(host)
    // Every entry in sensitiveHosts came from `sensitive`, so `cls` is
    // always defined here -- the `as` below is not a type escape hatch,
    // just TypeScript not following that through a Map lookup.
    return `${host} is ${describeAddressClass(cls as Exclude<AddressClass, 'public' | 'unparseable'>)}.`
  })
  const closingSentence = sensitiveHosts.length === 1 ? 'This is not part of the public internet.' : 'These are not part of the public internet.'

  return {
    warning: true,
    message: `⚠ ${verb} ${sensitiveHosts.join(', ')}${otherSitesClause}`,
    explanation: `${sentences.join(' ')} ${closingSentence}`
  }
}

/**
 * `tcp.connect` / `https.connect` / `udp.send` share one shape: host:port
 * patterns, a host wildcard that means "any public address" REGARDLESS of
 * its paired port (R2-01), and port breadth that must stay visible even
 * when the host is narrow (AR-02).
 *
 * A pattern whose host is the wildcard makes the WHOLE grant read as
 * unlimited, however many named patterns sit alongside it -- "any public
 * address" already subsumes every other declared host, so this branch
 * never calls `namedHostsSummary`: the wildcard host must never be rendered
 * as if it were a literal hostname (R2-01's own failure mode), and there is
 * nothing a specific host could add to "any address" that needs its own
 * mention in a one-line summary (D-0004 rejects an expander for the detail
 * that would take). What DOES still vary honestly is the port: a wildcard
 * host paired only with bounded ports is still unlimited in HOST terms, but
 * "any site, on port 443" is a real, narrower fact than "any site, any
 * port" and the addendum requires both to read differently.
 */
export function describeConnectCapability (
  verb: string,
  singular: string,
  plural: string,
  unlimitedExplanation: string,
  patterns: readonly Pattern[]
): CapabilityGrantSummary {
  const infos = parseConnectPatterns(patterns)
  const wildcard = infos.filter((info) => info.hostIsWildcard)
  const named = infos.filter((info) => !info.hostIsWildcard)

  if (wildcard.length > 0) {
    const fullyOpen = wildcard.some((info) => coversAllPorts(info.port))
    const explanation = fullyOpen
      ? unlimitedExplanation
      : `${unlimitedExplanation} Limited to ${portsListPhrase(wildcard.map((info) => info.port))}.`
    return { warning: true, message: WARNING_HEADLINE, explanation }
  }

  if (named.some((info) => info.nonPublicAddressClass !== null)) {
    return namedHostsSummaryWithSensitiveAddresses(verb, singular, plural, named)
  }

  return namedHostsSummary(verb, singular, plural, named)
}
