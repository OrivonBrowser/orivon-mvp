// What a Node or WASI program's bind address asks `orivon.net.listen` and
// `udpBind` for (ADR-0034), shared by the `net`, `dgram` and `wasi:sockets`
// shims so all three answer the same way.
import type { BindScope } from '../contracts/index.js'

/** Node's own spellings of the loopback interface; the broker's `'local'` binds `127.0.0.1`. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1'])

/** Every spelling of "every interface"; the broker's `'network'`. */
const ANY_INTERFACE_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '::', '::0', '0000:0000:0000:0000:0000:0000:0000:0000'])

/**
 * The scope a Node `host` argument asks for, or `undefined` for a host this
 * shim cannot honour (the broker binds loopback or every interface, never a
 * single other address). No host is Node's own default, every interface, so it
 * asks for `'network'`: what the app would get outside Orivon.
 */
export function scopeForHost (host: string | undefined): BindScope | undefined {
  if (host === undefined) return 'network'
  const name = host.toLowerCase()
  if (LOOPBACK_HOSTS.has(name)) return 'local'
  if (ANY_INTERFACE_HOSTS.has(name)) return 'network'
  return undefined
}

/**
 * Opens a listener or socket at `wanted`. A `'network'` ask the broker
 * refuses as `'denied'` is asked again as `'local'`, so an app holding only
 * the local grant still runs, on the narrower interface it can be given; the
 * caller reads the address it actually got from the handle. Every other
 * failure, and a `'local'` ask that is refused, is the caller's to report.
 * The fallback only ever narrows.
 */
export async function openAtScope<T> (open: (scope: BindScope) => Promise<T>, wanted: BindScope): Promise<T> {
  if (wanted === 'local') return await open('local')
  try {
    return await open('network')
  } catch (error) {
    if (typeof error !== 'object' || error === null || (error as { code?: unknown }).code !== 'denied') throw error
    return await open('local')
  }
}
