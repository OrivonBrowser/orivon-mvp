// The default Secure DNS choice ("Quad9 first; when it cannot be reached the platform's own DNS answers") kept for
// real. Chromium's `automatic` mode asks the platform's resolver until its own probe of the DoH server succeeds, which
// took tens of seconds on a network that hijacks DNS, and what that resolver answered stays in the host cache. So the
// choice runs in `secure` mode with Quad9 from the start, and falls back to `automatic` only when a lookup made through
// that very stack, cache bypassed, does not answer. A later check tries `secure` mode out again, since `automatic`
// cannot tell whether Quad9 answers, and keeps it when it does. Tied to Electron only through the functions it is given.
import type { ConfigureHostResolverOptions } from 'electron'
import { secureDnsOptions } from './secure-dns.js'

/** How often a check runs, in `secure` mode or in the fallback. */
export const QUAD9_CHECK_MS = 5 * 60_000
/** How often the network is looked at for coming back online, which triggers a check at once. */
export const ONLINE_POLL_MS = 10_000
/** How long a check waits for Quad9 before the fallback applies. */
export const QUAD9_PROBE_TIMEOUT_MS = 3000
/** A stable name whose address is not what is being asked: only whether an answer arrives. */
export const PROBE_NAME = 'example.com'

type ResolveHost = (host: string, options: { readonly cacheUsage: 'disallowed' }) => Promise<{ readonly endpoints: readonly unknown[] }>

/** Whether `resolveHost` answers `name` with an address within `timeoutMs`, bypassing the host cache. */
export async function probeWithin (resolveHost: ResolveHost, name: string, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const silent = new Promise<false>((resolve) => { timer = setTimeout(() => { resolve(false) }, timeoutMs) })
  try {
    const answered = resolveHost(name, { cacheUsage: 'disallowed' }).then((resolved) => resolved.endpoints.length > 0, () => false)
    return await Promise.race([answered, silent])
  } finally {
    clearTimeout(timer)
  }
}

export interface Quad9FallbackDeps {
  readonly configure: (options: ConfigureHostResolverOptions) => void
  /** Whether Quad9 answers through the resolver as configured now. */
  readonly probe: () => Promise<boolean>
  /** Forgets every address looked up so far, in the sessions that matter. */
  readonly clearCaches: () => Promise<void>
  readonly online: () => boolean
  readonly log: (line: string) => void
  /** Runs `task` every `ms` until the returned function is called. */
  readonly every: (task: () => void, ms: number) => () => void
}

export interface Quad9Fallback {
  start: () => void
  stop: () => void
}

export function createQuad9Fallback (deps: Quad9FallbackDeps): Quad9Fallback {
  const secure = secureDnsOptions('quad9')
  const fallback = secureDnsOptions('quad9Fallback')
  let mode: 'secure' | 'fallback' = 'secure'
  let checking = false
  let stopped = false
  let cancels: Array<() => void> = []

  const forget = (): void => { deps.clearCaches().catch((error: unknown) => { console.error('[privacy] could not clear the host cache:', error) }) }

  async function check (): Promise<void> {
    if (checking || stopped) return
    checking = true
    try {
      const trial = mode === 'fallback'
      if (trial) deps.configure(secure)
      const answered = await deps.probe().catch(() => false)
      if (stopped) return
      if (answered) {
        if (!trial) return
        mode = 'secure'
        forget()
        deps.log('[privacy] Secure DNS: Quad9 answers again, so it is used first')
      } else {
        if (!trial) {
          mode = 'fallback'
          deps.log('[privacy] Secure DNS: Quad9 does not answer, so this computer\'s DNS answers until it does')
        }
        deps.configure(fallback)
      }
    } finally {
      checking = false
    }
  }

  const runCheck = (): void => { check().catch((error: unknown) => { console.error('[privacy] the Secure DNS check failed:', error) }) }

  return {
    start: () => {
      stopped = false
      mode = 'secure'
      deps.configure(secure)
      forget()
      let wasOnline = deps.online()
      cancels = [
        deps.every(() => { runCheck() }, QUAD9_CHECK_MS),
        deps.every(() => {
          const now = deps.online()
          if (now && !wasOnline) runCheck()
          wasOnline = now
        }, ONLINE_POLL_MS)
      ]
      runCheck()
    },
    stop: () => {
      stopped = true
      for (const cancel of cancels) cancel()
      cancels = []
    }
  }
}
