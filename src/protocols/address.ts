// Between the address a person reads and the URL a page is served at:
// `ipfs://<cid>/docs/` is served at `https://<cid>.ipfs.orivon/docs/`, and a
// `.eth` name is its own host. Pure string work over the descriptors, so the
// shell needs no protocol's code to route or show one. Rationale: README.md.

import { ADDRESS_SUFFIX } from './protocol.js'
import type { ProtocolDescriptor } from './protocol.js'
import type { Namespace } from './resolution/providers.js'
import { isDnsLabel } from './resolution/dns-name.js'

/** A host the verifier serves, as the namespace it belongs to and the name within it. */
export interface ServedName {
  readonly namespace: Namespace
  readonly name: string
}

/**
 * What a name may hold when it is typed or linked, before its protocol
 * canonicalises it. No longer than a DNS name: a longer one can never become
 * a host, and a protocol's parser should never be handed an unbounded string.
 */
export const MAX_ADDRESS_NAME = 253
const ADDRESS_NAME = new RegExp(`^[A-Za-z0-9._~-]{1,${String(MAX_ADDRESS_NAME)}}$`)
const ADDRESS = /^([A-Za-z][A-Za-z0-9]*):\/\/([^/?#\s]+)([/?#]\S*)?$/

/**
 * A name as one host label, the way IPFS subdomain gateways inline a DNSLink
 * name: each `-` doubled, each `.` made a `-`. Undefined when the result is
 * not a DNS label, too long or not lowercase; when it starts `xn--`, which
 * Chromium parses as punycode and refuses; and when it does not decode back
 * to `name`, since `a.-b` and `a-.b` would otherwise share one origin.
 */
export function labelFor (name: string): string | undefined {
  const label = name.replace(/-/g, '--').replace(/\./g, '-')
  return isDnsLabel(label) && !label.startsWith('xn--') && nameFromLabel(label) === name ? label : undefined
}

/** labelFor, reversed. The alternation matches `--` before `-`, so a doubled hyphen is never read as two dots. */
function nameFromLabel (label: string): string {
  return label.replace(/--|-/g, (hyphens) => hyphens === '--' ? '-' : '.')
}

/** A trailing dot is kept, as an empty last label: Chromium's `MAP *.eth` does not match `vitalik.eth.`, so that host never reaches the verifier. */
function hostLabels (host: string): string[] {
  return host.toLowerCase().split('.')
}

export class ProtocolAddresses {
  private readonly schemes: ReadonlySet<string>
  private readonly topLevelDomains: ReadonlySet<string>

  constructor (protocols: readonly ProtocolDescriptor[]) {
    this.schemes = new Set(protocols.flatMap((p) => p.schemes))
    this.topLevelDomains = new Set(protocols.flatMap((p) => p.topLevelDomains))
  }

  /** Whether `scheme`, lowercase and without its colon, is a protocol's address scheme. */
  servesScheme (scheme: string): boolean {
    return this.schemes.has(scheme)
  }

  /** Every host suffix Chromium must send to the verifier: each top-level domain, and the one every scheme shares. */
  routedSuffixes (): string[] {
    return [...this.topLevelDomains, ADDRESS_SUFFIX]
  }

  routesToVerifier (host: string): boolean {
    const labels = hostLabels(host)
    const last = labels[labels.length - 1] ?? ''
    return labels.length >= 2 && labels.every((label) => label !== '') && this.routedSuffixes().includes(last)
  }

  /** `vitalik.eth` is `.eth`'s `vitalik.eth`; `<label>.ipfs.orivon` is `ipfs:`'s name for that label. */
  servedName (host: string): ServedName | undefined {
    const labels = hostLabels(host)
    if (labels.some((label) => label === '')) return undefined
    const [label, scheme, suffix] = labels
    if (labels.length === 3 && suffix === ADDRESS_SUFFIX && scheme !== undefined && this.schemes.has(scheme) && label !== undefined && isDnsLabel(label)) {
      return { namespace: `${scheme}:`, name: nameFromLabel(label) }
    }
    const tld = labels[labels.length - 1]
    if (labels.length >= 2 && tld !== undefined && this.topLevelDomains.has(tld)) return { namespace: `.${tld}`, name: labels.join('.') }
    return undefined
  }

  /** The scheme whose endpoint `host` is (`ipfs.orivon` for `ipfs`): it only ever redirects to a canonical origin. */
  schemeEndpoint (host: string): string | undefined {
    const [scheme, suffix, ...rest] = hostLabels(host)
    return rest.length === 0 && suffix === ADDRESS_SUFFIX && scheme !== undefined && this.schemes.has(scheme) ? scheme : undefined
  }

  /** The origin a canonical name is served at, or undefined when the name cannot be one host label. */
  originFor (scheme: string, name: string): string | undefined {
    const label = this.schemes.has(scheme) ? labelFor(name) : undefined
    return label === undefined ? undefined : `https://${label}.${scheme}.${ADDRESS_SUFFIX}`
  }

  /**
   * A typed or linked `ipfs://<name>/<path>`, as the URL to load: the
   * scheme's endpoint, which redirects to the origin of the name's canonical
   * spelling. Undefined for any input that is not a registered scheme's address.
   */
  servedUrl (input: string): string | undefined {
    const match = ADDRESS.exec(input.trim())
    if (match === null) return undefined
    const [, scheme = '', name = '', rest = ''] = match
    if (!this.schemes.has(scheme.toLowerCase()) || !ADDRESS_NAME.test(name)) return undefined
    const path = rest.startsWith('/') ? rest : `/${rest}`
    try {
      return new URL(`https://${scheme.toLowerCase()}.${ADDRESS_SUFFIX}/${name}${path}`).toString()
    } catch {
      return undefined
    }
  }

  /** The URL a person reads: `https://<label>.ipfs.orivon/x` is `ipfs://<name>/x`. Any other URL comes back unchanged. */
  displayUrl (url: string): string {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return url
    }
    if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username !== '' || parsed.password !== '') return url
    const tail = `${parsed.search}${parsed.hash}`
    const served = this.servedName(parsed.hostname)
    if (served?.namespace.endsWith(':') === true) return `${served.namespace}//${served.name}${parsed.pathname}${tail}`
    const scheme = this.schemeEndpoint(parsed.hostname)
    const endpoint = /^\/([^/]+)(\/.*)?$/.exec(parsed.pathname)
    if (scheme === undefined || endpoint === null) return url
    const [, name = '', path = '/'] = endpoint
    return `${scheme}://${name}${path}${tail}`
  }

  /** displayUrl, for an origin: `https://<label>.ipfs.orivon` is `ipfs://<name>`. */
  displayOrigin (origin: string): string {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      return origin
    }
    if (parsed.protocol !== 'https:' || parsed.port !== '') return origin
    const served = this.servedName(parsed.hostname)
    return served?.namespace.endsWith(':') === true ? `${served.namespace}//${served.name}` : origin
  }
}
