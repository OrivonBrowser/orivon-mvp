// What the root-dot specs share: a launch whose resolver hides nothing a leak of the root-dot spelling would use, and the
// reading of Chromium's own net log for the names a run asked about.
import { readFile } from 'node:fs/promises'
import type { ElectronApplication } from 'playwright'

/**
 * Nothing resolves except loopback, and a host that ends in a dot is left to whatever resolver would answer it: the
 * hermetic rule `MAP * ~NOTFOUND` would turn a root-dot name into "not found" before any resolver or any rule of Orivon's own
 * saw it, so a leak could not show. `EXCLUDE` cannot be used for this, because it exempts a host from Orivon's rules too.
 * The patterns end in a letter or a hyphen and not in a digit, because Chromium tries a pattern that fails on the host again
 * on `host:port` (`HostMappingRules::RewriteHost`), so a pattern ending in a digit matches a root-dot name asked for on a port
 * that ends in it: `MAP *0 ~NOTFOUND` rewrote `vitalik.eth.` (measured), by way of `vitalik.eth.:80`, a `dns-prefetch` from
 * an http page (read in Chromium's source, not measured), while `MAP *h ~NOTFOUND` left it alone.
 */
export const ALL_BUT_ROOT_DOT_RESOLVER = `--host-resolver-rules=${[...'abcdefghijklmnopqrstuvwxyz-'].map((last) => `MAP *${last} ~NOTFOUND`).join(', ')}, EXCLUDE 127.0.0.1`

interface RawEvent { readonly type: number, readonly source?: { readonly id: number }, readonly params?: unknown }
interface RawNetLog { readonly constants: { readonly logEventTypes: Record<string, number> }, readonly events: readonly RawEvent[] }

/** What Chromium's net log says about the requests and lookups for names that hold `needle`. */
export interface NetLogFacts {
  /** Requests the log saw start for such a URL: proof the log covers the run, so an empty list below means something. */
  readonly requests: number
  /** Lookups: every host-resolution event that names one. */
  readonly lookups: string[]
  /** The `CONNECT` lines sent to a proxy for such a host. */
  readonly tunnelled: string[]
  /** The proxy lists the requests for such a URL resolved to, one per request. */
  readonly proxies: string[]
}

export async function startNetLog (app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(async ({ netLog }, target) => { await netLog.startLogging(target, { captureMode: 'includeSensitive' }) }, path)
}

export async function stopNetLog (app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ netLog }) => { await netLog.stopLogging() })
}

/** Reads the log written to `path` for the names holding `needle`. */
export async function readNetLog (path: string, needle: string): Promise<NetLogFacts> {
  const log = JSON.parse(await readFile(path, 'utf8')) as RawNetLog
  const names = new Map(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]))
  const text = (event: RawEvent): string => JSON.stringify(event.params ?? {})
  const named = (event: RawEvent): string => names.get(event.type) ?? ''
  const startedUrl = (event: RawEvent): boolean => named(event) === 'URL_REQUEST_START_JOB' && text(event).includes(needle)
  const requestSources = new Set(log.events.filter(startedUrl).map((event) => event.source?.id))
  return {
    requests: requestSources.size,
    lookups: log.events.filter((event) => /HOST_RESOLVER/.test(named(event)) && text(event).includes(needle)).map((event) => `${named(event)} ${text(event)}`),
    tunnelled: log.events.filter((event) => named(event) === 'HTTP_TRANSACTION_SEND_TUNNEL_HEADERS' && text(event).includes(needle)).map(text),
    proxies: log.events.filter((event) => named(event) === 'PROXY_RESOLUTION_SERVICE_RESOLVED_PROXY_LIST' && requestSources.has(event.source?.id)).map(text)
  }
}

/** What the proxy scripts that ran said through `alert`, which Chromium's net log records as the script's own words: proof of the hosts a script was run with. */
export async function readPacAlerts (path: string): Promise<string[]> {
  const log = JSON.parse(await readFile(path, 'utf8')) as RawNetLog
  const names = new Map(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]))
  return log.events.filter((event) => names.get(event.type) === 'PAC_JAVASCRIPT_ALERT').map((event) => JSON.stringify(event.params ?? {}))
}

/** Every address Chromium's own sockets tried to connect to (`ip:port`), from the connection attempts the net log recorded: the proof of where a run's traffic left this computer. */
export async function readConnectedAddresses (path: string): Promise<string[]> {
  const log = JSON.parse(await readFile(path, 'utf8')) as RawNetLog
  const names = new Map(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]))
  return log.events.filter((event) => names.get(event.type) === 'TCP_CONNECT_ATTEMPT').map((event) => (event.params as { address?: string } | undefined)?.address).filter((address): address is string => typeof address === 'string')
}
