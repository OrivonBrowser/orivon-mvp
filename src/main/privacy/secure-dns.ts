// "Secure DNS": looking site names up over HTTPS, so the network cannot see or
// change the answers. The setting's values become one
// `app.configureHostResolver` call; the default, `quad9Fallback`, is Quad9 first and the platform's DNS
// when Quad9 cannot be reached, and which of the two applies is decided over time by `secure-dns-fallback.ts`
// (Chromium's `automatic` mode alone answers from the platform's DNS until its own probe succeeds). Names a `--host-resolver-rules` clause maps
// (the `.eth` names, a test's fixtures) are answered by those rules before any
// resolver is asked, so they never reach a DNS provider. Tied to Electron
// only through the `configureHostResolver` it is given.
import type { ConfigureHostResolverOptions } from 'electron'

export type SecureDnsValue = 'quad9Fallback' | 'off' | 'automatic' | 'cloudflare' | 'quad9'

const PROVIDERS: Readonly<Record<'cloudflare' | 'quad9', string>> = {
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  quad9: 'https://dns.quad9.net/dns-query'
}

/**
 * The resolver options for a setting value. Secure lookups need Chromium's own
 * resolver, which Electron leaves off on Linux and Windows, so any value but
 * `off` turns it on; `off` puts it back to the platform's default.
 */
export function secureDnsOptions (value: SecureDnsValue, platform: string = process.platform): ConfigureHostResolverOptions {
  switch (value) {
    case 'off': return { secureDnsMode: 'off', enableBuiltInResolver: platform === 'darwin' }
    // Quad9 first; when it cannot be reached the platform's own DNS answers, so a network that blocks it does not lose its names.
    case 'quad9Fallback': return { secureDnsMode: 'automatic', secureDnsServers: [PROVIDERS.quad9], enableBuiltInResolver: true }
    case 'automatic': return { secureDnsMode: 'automatic', enableBuiltInResolver: true }
    case 'cloudflare': return { secureDnsMode: 'secure', secureDnsServers: [PROVIDERS.cloudflare], enableBuiltInResolver: true }
    case 'quad9': return { secureDnsMode: 'secure', secureDnsServers: [PROVIDERS.quad9], enableBuiltInResolver: true }
  }
}

export interface ResolverTarget {
  configureHostResolver: (options: ConfigureHostResolverOptions) => void
}

/**
 * Whether this run was started with secure DNS forced off from outside (`ORIVON_SECURE_DNS=off`), as every test and
 * smoke launch is, so none of them asks a DNS provider. It stands in for the default only: a profile that names a
 * choice keeps it.
 */
export const secureDnsForcedOff = (env: NodeJS.ProcessEnv = process.env): boolean => env['ORIVON_SECURE_DNS'] === 'off'

/** The value this run applies: what the setting says, except that a forced-off run replaces the default with `off`. */
export function effectiveSecureDns (value: SecureDnsValue, isDefault: boolean, forcedOff: boolean): SecureDnsValue {
  return forcedOff && isDefault ? 'off' : value
}

/** Whether the launch needs a call at all: on Linux and Windows `off` is what the resolver already does. */
export function needsResolverCall (value: SecureDnsValue, platform: string = process.platform): boolean {
  return value !== 'off' || platform === 'darwin'
}

/** Applies `options`; a rejected call is logged and leaves the resolver as it was. */
export function configureResolver (target: ResolverTarget, options: ConfigureHostResolverOptions): void {
  try {
    target.configureHostResolver(options)
  } catch (error) {
    console.error('[privacy] could not configure secure DNS:', error)
  }
}

/** Applies `value`; for `quad9Fallback` this is only the platform fallback half, `secure-dns-fallback.ts` decides when it applies. */
export function applySecureDns (target: ResolverTarget, value: SecureDnsValue): void {
  configureResolver(target, secureDnsOptions(value))
}
