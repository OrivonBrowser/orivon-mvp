// Which configured gateways have no proxy in front of them right now --
// the one condition the DNS-tamper fallback (verifier-host/dns-fallback.ts)
// requires before it will ever reach a gateway directly, bypassing
// whatever proxy the system might otherwise apply. Pure with respect to
// Electron: `resolveProxy` is injected, so this stays testable under plain
// vitest the same way this directory's other `<name>.ts` files are
// (verifier-subsystem.ts is the one file here that imports `electron`).

import { withTimeout } from '../../protocols/resolution/timing.js'

/** How long one gateway's proxy check may take before it counts as
 * "proxied" -- fails closed, the same direction a check that errors takes:
 * a system that cannot even answer "is there a proxy" is not one the
 * fallback should treat as proxy-free. */
const PROXY_CHECK_TIMEOUT_MS = 2_000

/**
 * Every gateway in `gateways` whose exact answer from `resolveProxy` is
 * `'DIRECT'` -- Chromium's own wording for "no proxy applies to this URL",
 * which `session.resolveProxy`/`app.resolveProxy` return verbatim. A PAC
 * script can answer differently per URL, so each gateway is checked on its
 * own rather than once for the whole list. A timeout or a thrown error
 * counts as proxied: this only ever GATES a fallback that reaches a
 * gateway directly, so failing closed here costs nothing but a gateway
 * that stays reachable only through `net.fetch`, same as it is today.
 */
export async function unproxiedGateways (gateways: readonly string[], resolveProxy: (url: string) => Promise<string>): Promise<string[]> {
  const checked = await Promise.all(gateways.map(async (gateway) => {
    try {
      return (await withTimeout(resolveProxy(gateway), PROXY_CHECK_TIMEOUT_MS, 'the proxy check')).trim() === 'DIRECT'
    } catch {
      return false
    }
  }))
  return gateways.filter((_gateway, index) => checked[index] === true)
}
