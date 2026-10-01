// "Secure DNS": looking site names up over HTTPS, so the network cannot see or
// change the answers. The setting's four values become one
// `app.configureHostResolver` call. Names a `--host-resolver-rules` clause maps
// (the `.eth` names, a test's fixtures) are answered by those rules before any
// resolver is asked, so they never reach a DNS provider. Tied to Electron
// only through the `configureHostResolver` it is given.
import type { ConfigureHostResolverOptions } from 'electron'

export type SecureDnsValue = 'off' | 'automatic' | 'cloudflare' | 'quad9'

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
    case 'automatic': return { secureDnsMode: 'automatic', enableBuiltInResolver: true }
    case 'cloudflare': return { secureDnsMode: 'secure', secureDnsServers: [PROVIDERS.cloudflare], enableBuiltInResolver: true }
    case 'quad9': return { secureDnsMode: 'secure', secureDnsServers: [PROVIDERS.quad9], enableBuiltInResolver: true }
  }
}

export interface ResolverTarget {
  configureHostResolver: (options: ConfigureHostResolverOptions) => void
}

/** Whether the launch needs a call at all: on Linux and Windows `off` is what the resolver already does. */
export function needsResolverCall (value: SecureDnsValue, platform: string = process.platform): boolean {
  return value !== 'off' || platform === 'darwin'
}

/** Applies `value`; a rejected call is logged and leaves the resolver as it was. */
export function applySecureDns (target: ResolverTarget, value: SecureDnsValue): void {
  try {
    target.configureHostResolver(secureDnsOptions(value))
  } catch (error) {
    console.error('[privacy] could not configure secure DNS:', error)
  }
}
