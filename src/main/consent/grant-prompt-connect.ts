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
import { RESERVED_PORTS, patternNamesPortExactly } from '../../broker/policy/reserved-ports.js'
import { covers as patternCovers } from '../../broker/policy/update.js'
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
  /** The part of `explanation` that states reach beyond what the headline
   * says: a port Orivon keeps closed to broad grants that the grant names,
   * or a named host the wildcard does not cover. Kept apart so a level that
   * drops the explanation (`./grant-level.ts`) can still say it. */
  readonly reach?: string
}

/** The one glyph every warned row's `message` opens with (or, for a
 * multi-line message, every line opens with) -- extracted so `./grant-
 * level.ts`'s `summaryAtLevel` has exactly one string to strip, rather than
 * re-deriving the marker from each literal that uses it. */
export const WARNING_MARK = '⚠ '

/**
 * Plan decision 10, "row lists capped": how many individual items (a
 * web.context origin, an embed host, a sensitive address, a port) any ONE
 * list in a consent dialog names before the rest fold into a single "and N
 * more" line -- a manifest can declare up to `MAX_PATTERNS` (256) of any of
 * these, each on its own line with nothing here that scrolls, and a native
 * `dialog.showMessageBox` grows exactly as tall as its longest string.
 * Deliberately well under `MAX_PATTERNS`: a real, curated declaration reads
 * fine at this length, and the point past it is presentation, not policy --
 * retune freely.
 */
export const MAX_LISTED_ROWS = 20

/**
 * `items` capped to `MAX_LISTED_ROWS`, plus how many were left out -- the
 * one place every per-item list in this file (and grant-prompt-render.ts's
 * web.context origins, grant-prompt-embed.ts's embed hosts) shares the same
 * cap and the same "and N more" wording, rather than each re-deriving its
 * own slice-and-count.
 */
export function cappedRows<T> (items: readonly T[]): { readonly shown: readonly T[], readonly more: number } {
  if (items.length <= MAX_LISTED_ROWS) return { shown: items, more: 0 }
  return { shown: items.slice(0, MAX_LISTED_ROWS), more: items.length - MAX_LISTED_ROWS }
}

/** `cappedRows` joined for an inline, comma-separated clause (embed hosts, a
 * sensitive-address list): `"a, b, c and 5 more"` once the cap bites, never
 * a bare, unbounded `.join(', ')`. */
export function joinCapped (items: readonly string[]): string {
  const { shown, more } = cappedRows(items)
  if (more === 0) return shown.join(', ')
  return `${shown.join(', ')} and ${String(more)} more`
}

const WARNING_HEADLINE = `${WARNING_MARK}Unlimited network access`

/** `port 443`, or `ports 22, 443, 5432` for more than one -- shared by
 * `tcp.listen`/`udp.bind`'s own rendering (grant-prompt-render.ts) and
 * connect breadth here (AR-02), rather than a second joiner. */
export function portsPhrase (patterns: readonly Pattern[]): string {
  return patterns.length === 1 ? `port ${patterns[0]}` : `ports ${joinCapped(patterns)}`
}

/** One parsed `host:port` pattern, via the SAME grammar the runtime
 * matcher uses -- never a second guess at the string. A pattern the real
 * grammar cannot parse authorises nothing at connect time
 * (`connect-patterns.ts`'s own doc on `parsePattern`), so it contributes
 * nothing here either, rather than being rendered as if it were a host. */
interface ConnectPatternInfo {
  readonly raw: Pattern
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
      raw: pattern,
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

/** What each port `reserved-ports.ts` keeps closed to broad grants is for,
 * in the words a person would use for it. Every entry of `RESERVED_PORTS`
 * needs one; the test over `RESERVED_PORTS` fails when one is missing. */
const RESERVED_PORT_PURPOSE: Readonly<Record<number, string>> = {
  23: 'telnet',
  25: 'mail',
  465: 'mail',
  587: 'mail',
  53: 'DNS',
  139: 'Windows file sharing',
  445: 'Windows file sharing',
  3389: 'remote desktop',
  6667: 'IRC chat',
  6697: 'IRC chat'
}

/** `a`, `a and b`, `a, b and c`. */
function joinAnd (items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${String(items[items.length - 1])}`
}

/** `joinAnd` with the list capped at `MAX_LISTED_ROWS` and the rest counted. */
function joinAndCapped (items: readonly string[]): string {
  const { shown, more } = cappedRows(items)
  return more === 0 ? joinAnd(shown) : `${shown.join(', ')} and ${String(more)} more`
}

/** The reserved ports (`reserved-ports.ts`) a set of wildcard-host patterns
 * names as a single port, ascending -- the only way a wildcard host reaches
 * one, which a broad `*:*` or a range never does. */
function reservedPortsNamed (wildcard: readonly ConnectPatternInfo[]): readonly number[] {
  return [...RESERVED_PORTS]
    .filter((port) => wildcard.some((info) => patternNamesPortExactly(info, port)))
    .sort((a, b) => a - b)
}

/** `mail (25, 465 and 587) and DNS (53)`: the ports grouped by what they are for. */
function describePortPurposes (ports: readonly number[]): string {
  const groups = new Map<string, number[]>()
  for (const port of ports) {
    const purpose = RESERVED_PORT_PURPOSE[port] ?? 'closed to broad grants'
    groups.set(purpose, [...(groups.get(purpose) ?? []), port])
  }
  return joinAnd([...groups].map(([purpose, list]) => `${purpose} (${joinAnd(list.map(String))})`))
}

/** `onlyNamed`: the grant's wildcard reaches nothing but these ports, so
 * "also" would say something the limit sentence before it already said. */
function closedPortsSentence (ports: readonly number[], onlyNamed: boolean): string {
  if (ports.length === 0) return ''
  const reach = onlyNamed ? 'It can reach' : 'It can also reach'
  return `${reach} ${ports.length === 1 ? 'a port' : 'ports'} Orivon keeps closed to broad grants: ${describePortPurposes(ports)}.`
}

function isSinglePort (portSpec: string): boolean {
  const parsed = parsePortSpec(portSpec)
  return parsed !== null && parsed !== 'any' && parsed.lo === parsed.hi
}

/** One spelling per port spec: `6697-6697` is `6697`, so two spellings of one port are listed once. An unreadable spec stays as written. */
function canonicalPortSpec (portSpec: string): string {
  const parsed = parsePortSpec(portSpec)
  if (parsed === null) return portSpec
  if (parsed === 'any') return '*'
  return parsed.lo === parsed.hi ? String(parsed.lo) : `${String(parsed.lo)}-${String(parsed.hi)}`
}

/** `port 443`, or `any port` for a wildcard/full-range spec -- the same
 * shape `portsPhrase` renders, reused here for connect breadth (AR-02)
 * rather than a second joiner. `labelReserved`: a single reserved port says
 * what it is for, where the sentence has no other place to. */
function portsListPhrase (specs: readonly string[], labelReserved = false): string {
  const unique = Array.from(new Set(specs.map(canonicalPortSpec)))
  if (unique.length === 1) {
    const only = unique[0]
    if (only !== undefined && coversAllPorts(only)) return 'any port'
  }
  return portsPhrase(unique.map((spec) => {
    const parsed = parsePortSpec(spec)
    const purpose = labelReserved && parsed !== null && parsed !== 'any' && parsed.lo === parsed.hi ? RESERVED_PORT_PURPOSE[parsed.lo] : undefined
    return purpose === undefined ? spec : `${spec} (${purpose})`
  }))
}

// A133: anchored on something a count of hosts can actually be compared
// against -- `MAX_PATTERNS`, the real, already-enforced ceiling on how many
// patterns ONE capability's array may declare at all
// (loader/manifest/capabilities.ts) -- rather than a guessed digit count: a
// real 12-host feed-reader manifest is a narrow declaration by any sensible
// reading, not a breadth risk, so the threshold must sit well above it. This
// fires only once a manifest names at least HALF of the hosts the format
// permits it to name -- comfortably above any curated, human-reviewable
// list (a feed reader, a CDN allowlist), and close enough to the format's
// own maximum that naming individual hosts has stopped being a meaningfully
// narrower declaration than not naming any. Presentation, not policy --
// retune freely; see this directory's README, Design notes, for the full
// reasoning.
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
      message: `${WARNING_MARK}${verb} a large number of ${plural}`,
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

  // Every SHOWN sensitive host still gets its own sentence (A197: never
  // folded into a bare count) -- only the ROW COUNT is capped (decision 10),
  // and the ones left out are still named as a number, in `moreClause`
  // below, never silently dropped the way `otherSitesClause` drops ordinary
  // hosts.
  const { shown: shownSensitiveHosts, more: moreSensitiveHosts } = cappedRows(sensitiveHosts)
  const sentences = shownSensitiveHosts.map((host) => {
    const cls = classByHost.get(host)
    // Every entry in sensitiveHosts came from `sensitive`, so `cls` is
    // always defined here -- the `as` below is not a type escape hatch,
    // just TypeScript not following that through a Map lookup.
    return `${host} is ${describeAddressClass(cls as Exclude<AddressClass, 'public' | 'unparseable'>)}.`
  })
  const closingSentence = sensitiveHosts.length === 1 ? 'This is not part of the public internet.' : 'These are not part of the public internet.'
  const moreClause = moreSensitiveHosts === 0 ? '' : ` It also names ${String(moreSensitiveHosts)} more address${moreSensitiveHosts === 1 ? '' : 'es'} like this.`

  return {
    warning: true,
    message: `${WARNING_MARK}${verb} ${joinCapped(sensitiveHosts)}${otherSitesClause}`,
    explanation: `${sentences.join(' ')} ${closingSentence}${moreClause}`
  }
}

/**
 * What a named pattern adds to a wildcard grant: a host the wildcard does not
 * cover. `*` reaches public hosts only, never a reserved port through `*:*`
 * or a range, and only its own ports, so a LAN address, a reserved port or an
 * unlisted port named beside it is reach the headline does not state. Whether
 * a pattern is covered is `update.ts`'s own `covers`, the question "does this
 * change widen the grant" asks, so the two cannot disagree.
 */
function extraReachSentence (wildcard: readonly ConnectPatternInfo[], named: readonly ConnectPatternInfo[]): string {
  const extras = named.filter((info) => !wildcard.some((w) => patternCovers(w.raw, info.raw)))
  if (extras.length === 0) return ''

  const hosts = Array.from(new Set(extras.map((info) => info.host)))
  const items = hosts.map((host) => {
    const own = extras.filter((info) => info.host === host)
    const cls = own[0]?.nonPublicAddressClass ?? null
    const classClause = cls === null ? '' : ` (${describeAddressClass(cls as Exclude<AddressClass, 'public' | 'unparseable'>)})`
    return `${host} on ${portsListPhrase(own.map((info) => info.port), true)}${classClause}`
  })
  return `It can also reach ${joinAndCapped(items)}.`
}

/**
 * `tcp.connect` / `https.connect` / `udp.send` share one shape: host:port
 * patterns, a host wildcard that means "any public address" REGARDLESS of
 * its paired port (R2-01), and port breadth that must stay visible even
 * when the host is narrow (AR-02).
 *
 * A pattern whose host is the wildcard makes the row read as unlimited, and
 * the wildcard host is never rendered as if it were a literal hostname
 * (R2-01's own failure mode). The explanation then says what is true of the
 * whole grant: the wildcard's own port limit ("any site, on port 443" is a
 * narrower fact than "any site, any port", and each limit names what it
 * limits, since rows of different capabilities may share one headline), the
 * closed ports the grant names, and every named pattern the wildcard does
 * not already cover. A named pattern the wildcard covers adds nothing to say
 * (D-0004 rejects an expander for the detail that would take).
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
    const limit = fullyOpen ? '' : ` Its reach to any ${singular} is limited to ${portsListPhrase(wildcard.map((info) => info.port))}.`
    const closed = reservedPortsNamed(wildcard)
    const onlyNamed = wildcard.every((info) => closed.some((port) => patternNamesPortExactly(info, port)))
    const reach = [closedPortsSentence(closed, onlyNamed), extraReachSentence(wildcard, named)].filter((sentence) => sentence !== '').join(' ')
    const explanation = `${unlimitedExplanation}${limit}${reach === '' ? '' : ` ${reach}`}`
    return { warning: true, message: WARNING_HEADLINE, explanation, ...(reach === '' ? {} : { reach }) }
  }

  if (named.some((info) => info.nonPublicAddressClass !== null)) {
    return namedHostsSummaryWithSensitiveAddresses(verb, singular, plural, named)
  }

  return namedHostsSummary(verb, singular, plural, named)
}
