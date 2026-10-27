// Helios, the Ethereum light client, behind the EIP-1193 provider the ENS
// resolver reads through. Before Helios loads, this process's global fetch
// becomes the light client's allowlisted one, and WebSocket is removed:
// Helios reaches the network only through globals, and nothing else here
// uses them. README.md's Design notes cover the four wrappers it needs.

import { ResolutionError } from '../../resolution/records.js'
import { withTimeout } from '../../resolution/timing.js'
import type { WebFetch } from '../egress.js'
import { clockJump, heliosClockLead, installHeliosClock, measureClockLead, setHeliosClockLead } from './clock.js'
import { checkMainnet, wrongChainText } from './chain-check.js'
import { maskEndpoint } from './endpoint-mask.js'
import { CLOCK_AHEAD_REASON, CLOCK_BEHIND_REASON, bootstrapMissing, clockBehind, heliosError, outOfSync, serverBehindReason } from './helios-errors.js'
import { laneNames, publicText } from './lane-names.js'
import { failoverRpc } from './rpc-failover.js'
import { BLOCK_ROOT_PATTERN } from '../protocol.js'
import type { FromHost, LightClientConfig, LightClientState, TunnelRoute } from '../protocol.js'
import type { LightClient } from '../service.js'

/** How long a `.eth` load waits for the first sync before "cannot verify yet", with no tunnel (pace.ts holds the tunnel's). */
export const SYNC_WAIT_MS = 8_000
const SYNC_TIMEOUT_MS = 5 * 60_000
const FIRST_RETRY_MS = 5_000
const MAX_RETRY_MS = 5 * 60_000
const REFRESH_MS = 60_000
/** How soon a failed refresh tries again -- much sooner than a full
 * `REFRESH_MS` interval, so a transient RPC blip clears well within its own
 * grace window below rather than waiting out the ordinary cadence. */
export const REFRESH_RETRY_MS = 5_000
/** A failed head read this soon after the last SUCCESSFUL one leaves the
 * client `synced` -- one bad RPC call must not fail every `.eth` mount until
 * the next refresh when the head this process already proved is still
 * fresh enough to keep answering with. */
const HEAD_GRACE_MS = 2 * 60_000

interface Helios {
  request: (args: { method: string, params?: unknown }) => Promise<unknown>
  waitSynced: () => Promise<void>
  destroy: () => Promise<void>
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function notSyncedReason (state: LightClientState): string {
  if (state.state !== 'failed') return 'the light client is still syncing; reload in a moment'
  const retry = state.retryAt === undefined ? '' : `; it tries again in ${String(Math.max(1, Math.ceil((state.retryAt - Date.now()) / 1000)))} s`
  return `the light client failed: ${state.reason}${retry}`
}

async function finalizedTimestamp (helios: Helios): Promise<number | undefined> {
  const block = await helios.request({ method: 'eth_getBlockByNumber', params: ['finalized', false] }) as { timestamp?: unknown } | null
  return typeof block?.timestamp === 'string' ? Number(BigInt(block.timestamp)) : undefined
}

/**
 * Helios's WASM timer panics, taking the whole client down, the first time
 * a consensus request fails, unless it finds a worker-like global scope.
 */
function installTimerScope (): void {
  const scope = class WorkerGlobalScope {
    static [Symbol.hasInstance] (value: unknown): boolean { return value === globalThis }
  }
  Object.defineProperty(globalThis, 'WorkerGlobalScope', { value: scope, configurable: true, writable: true })
}

/** What Helios is told to call the two servers, and the server each name stands for. */
interface Lane {
  readonly execution: string
  readonly consensus: string
  /** Where a request under `consensus` really goes. */
  readonly realConsensus: string
  /** The execution RPC, tried endpoint by endpoint; replaced when a server is found to be on another chain. */
  viaExecution: WebFetch
  readonly fetch: WebFetch
}

/** `globalThis.fetch` once Helios's requests are told apart by the server they name: one lane per light client. */
interface Dispatcher {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>
  lanes: Lane[]
}

function dispatcher (): Dispatcher {
  const existing = globalThis.fetch as Partial<Dispatcher>
  if (existing.lanes !== undefined) return existing as Dispatcher
  const nodeFetch = globalThis.fetch
  const lanes: Lane[] = []
  const dispatch = (async (input: string | URL | Request, init?: RequestInit) => {
    // Helios loads its own WASM from a data: URL through fetch; that never touches the network.
    const request = new Request(input, init)
    if (request.url.startsWith('data:application/wasm')) return await nodeFetch(request)
    // Its RPC calls arrive as Request objects: method, headers and body live on the Request, not in init.
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
    const forwarded: RequestInit = { method: request.method, headers: Object.fromEntries(request.headers), ...(body === undefined ? {} : { body }), signal: request.signal }
    const execution = lanes.find((lane) => request.url === lane.execution || request.url === `${lane.execution}/`)
    const consensus = lanes.find((lane) => request.url === lane.consensus || request.url.startsWith(`${lane.consensus}/`))
    let response: Response
    if (execution !== undefined) response = await execution.viaExecution(request.url, forwarded)
    else if (consensus !== undefined) response = await consensus.fetch(`${consensus.realConsensus.replace(/\/$/, '')}${request.url.slice(consensus.consensus.length)}`, forwarded)
    // Helios is only ever given the names of a lane, so any other address is refused rather than handed to a lane that might send it elsewhere.
    else throw new Error(`the light client asked for ${new URL(request.url).origin}, which no client of this process uses`)
    // Electron's net.fetch leaves url empty; Helios parses it, and throws from inside its WASM, ending the process.
    if (response.url === '') Object.defineProperty(response, 'url', { value: request.url })
    return response
  }) as Dispatcher
  dispatch.lanes = lanes
  globalThis.fetch = dispatch as typeof globalThis.fetch
  return dispatch
}

/** What pace.ts says about when the client starts and how long a request waits for its first sync. */
export interface LightClientPace {
  readonly syncWaitMs: number
  readonly startAfterMs: number
}

export function startHeliosLightClient (config: LightClientConfig, fetch: WebFetch, report: (message: FromHost) => void, route: 'direct' | TunnelRoute = 'direct', pace: LightClientPace = { syncWaitMs: SYNC_WAIT_MS, startAfterMs: 0 }): LightClient {
  if (!BLOCK_ROOT_PATTERN.test(config.checkpoint)) throw new Error(`not a checkpoint: ${config.checkpoint}`)
  const primary = config.executionRpcs[0]
  if (primary === undefined) throw new Error('no execution RPC configured')
  installTimerScope()
  installHeliosClock()
  const names = laneNames(route)
  /** The last trouble each execution server was seen in, by address: a status or a code, never the address or a server's text. */
  const problems = new Map<string, string>()
  const noteProblem = (endpoint: string, problem: string | undefined): void => { if (problem === undefined) problems.delete(endpoint); else problems.set(endpoint, problem) }
  /** The execution servers in use: all of them, less those found on another chain. */
  let asked = config.executionRpcs
  const lane: Lane = { ...names, realConsensus: config.consensusRpc, viaExecution: failoverRpc(asked, fetch, noteProblem), fetch }
  // A client of this route started before is replaced: only one lives in a process.
  const lanes = dispatcher().lanes
  const earlier = lanes.findIndex((other) => other.execution === lane.execution)
  if (earlier >= 0) lanes.splice(earlier, 1)
  lanes.push(lane)
  Object.defineProperty(globalThis, 'WebSocket', { value: undefined, configurable: true, writable: true })

  let state: LightClientState = { state: 'starting' }
  let helios: Helios | undefined
  let markSynced: () => void = () => {}
  let synced = new Promise<void>((resolve) => { markSynced = resolve })
  let lastCheckpoint: string | undefined
  /** The local clock time of the last SUCCESSFUL head read -- not the
   * block's own timestamp, which is chain time and does not move with a
   * skewed local clock the same way. */
  let lastHeadReadAt: number | undefined
  /** Refresh failures since the last success. Reset on every success --
   * this is "since success", not "ever", so a client that has been failing
   * for a while and then recovers gets full tolerance again immediately. */
  let consecutiveFailures = 0
  /** Whether a failure for a clock behind or ahead of the chain has already been answered with an immediate second try. */
  let clockRetried = false
  /** Whether the lead may be wrong and the servers are still to be asked: set by a clock set back, or set forward with a lead lent, or a stall with a lead lent, or a refresh that found the head too old; cleared once they have answered. */
  let recheckDue = false
  /** The monotonic time of the last measurement, so a due one is tried at most once a `REFRESH_MS`. */
  let lastMeasuredAt = Number.NEGATIVE_INFINITY

  const setState = (next: LightClientState): void => {
    state = next
    report({ type: 'status', status: next })
  }

  /** Helios's words, or a fetch's, as they may be shown or logged: the lane names read as the servers, masked, with no key in them. */
  const clean = (text: string): string => publicText(text, names, config)
  const cleaned = (error: unknown): unknown => {
    if (!(error instanceof Error)) return error
    const text = clean(error.message)
    return text === error.message ? error : new Error(text)
  }
  /** The trouble of every execution server in use, when each has one and they are the person's own: the answer to "which server broke". */
  const ownTrouble = (): string | undefined => {
    if (config.ownServers?.execution !== true || asked.length === 0 || !asked.every((endpoint) => problems.has(endpoint))) return undefined
    return asked.map((endpoint) => `${maskEndpoint(endpoint)} ${problems.get(endpoint) ?? ''}`).join('; ')
  }
  const reportedWrongChain = new Set<string>()
  /** Drops a server of the person's that is not Ethereum mainnet, and fails the start when none is. */
  const checkChain = async (): Promise<void> => {
    if (config.ownServers?.execution !== true) return
    const { usable, wrong } = await checkMainnet(config.executionRpcs, fetch)
    asked = usable
    lane.viaExecution = failoverRpc(asked, fetch, noteProblem)
    for (const { endpoint, chainId } of wrong) {
      if (reportedWrongChain.has(endpoint)) continue
      reportedWrongChain.add(endpoint)
      console.error(`[verifier] ${wrongChainText(endpoint, chainId)}; it is not used`)
    }
    if (usable.length === 0) throw new Error(wrong.map(({ endpoint, chainId }) => wrongChainText(endpoint, chainId)).join('; '))
  }

  /** The only step allowed to change `state`. Throws on failure; the
   * caller decides what that means (below), rather than this function
   * silently downgrading on every blip. */
  const refreshHead = async (client: Helios): Promise<void> => {
    const head = await client.request({ method: 'eth_getBlockByNumber', params: ['latest', false] }) as { number?: unknown, timestamp?: unknown } | null
    if (typeof head?.number !== 'string' || typeof head.timestamp !== 'string') throw new Error('the light client has no verified block')
    lastHeadReadAt = Date.now()
    consecutiveFailures = 0
    const at = Number(BigInt(head.timestamp)) * 1000
    const lead = heliosClockLead()
    setState({ state: 'synced', block: Number(BigInt(head.number)), at, ...(lead !== 0 && { clockLeadMs: lead }) })
    // Wakes a request waiting in `provider.request` the moment a refresh
    // recovers from a downgrade, instead of after its full SYNC_WAIT_MS.
    markSynced()
  }

  /** Never changes state, on success or failure -- a checkpoint is a bonus
   * the shell persists for next launch, not something a `.eth` load waits
   * on, so its own failure (a slow/flaky finalized-block read, say) must
   * never be why a mount fails. */
  const reportCheckpoint = async (client: Helios): Promise<void> => {
    const root = await client.request({ method: 'helios_getCurrentCheckpoint', params: [] })
    const timestamp = await finalizedTimestamp(client)
    if (typeof root === 'string' && timestamp !== undefined && root !== lastCheckpoint) {
      lastCheckpoint = root
      report({ type: 'checkpoint', root: root.toLowerCase(), timestamp })
    }
  }

  /** Self-scheduling rather than a free-running interval: the next refresh
   * is soon (REFRESH_RETRY_MS) after a FAILED attempt, not stuck on the
   * ordinary REFRESH_MS cadence, so a transient blip clears well within
   * HEAD_GRACE_MS instead of waiting out the full minute. `delayMs` is
   * passed explicitly by whichever branch below just ran, rather than
   * re-derived from `state` -- `state` deliberately stays `synced` for a
   * failure still inside its grace window (below), so reading it back here
   * would wrongly schedule the NEXT retry a full minute out too, defeating
   * the fast-retry this function exists to give. */
  const scheduleRefresh = (client: Helios, delayMs: number): void => {
    const timer = setTimeout(() => {
      recheckClock().then(async () => { await refreshHead(client) }).then(
        () => { scheduleRefresh(client, REFRESH_MS) },
        (error: unknown) => {
          console.error('[verifier] light client refresh failed:', clean(message(error)))
          consecutiveFailures++
          // Still synced, without touching `state`, while the last proven
          // head is within its grace window AND this is the first failure
          // since the last success -- one bad RPC call must not fail every
          // `.eth` mount for up to a minute when the head this process
          // already proved is still fresh enough to answer with, but two in
          // a row (still well inside the grace window) reads as something
          // more than a single blip, and downgrades early rather than
          // waiting out the rest of the window on a client that may have
          // genuinely stopped syncing.
          const insideGrace = lastHeadReadAt !== undefined && Date.now() - lastHeadReadAt <= HEAD_GRACE_MS
          if (!(insideGrace && consecutiveFailures < 2) && state.state === 'synced') {
            // A stall while a lead is lent may be the lead's fault, and a head that looks too old may be a clock that has drifted ahead.
            if (heliosClockLead() !== 0 || outOfSync(error) !== undefined) recheckDue = true
            synced = new Promise<void>((resolve) => { markSynced = resolve })
            setState({ state: 'syncing', since: Date.now() })
          }
          scheduleRefresh(client, REFRESH_RETRY_MS)
        }
      )
    }, delayMs)
    timer.unref()
    // A checkpoint is asked for on the ordinary REFRESH_MS cadence only,
    // never on a fast retry: it is a bonus the shell persists for next
    // launch, not something worth re-asking for every REFRESH_RETRY_MS
    // during an outage, which would otherwise hit the endpoint up to 12x
    // more often than intended for as long as the outage lasts. Its own
    // failure is logged and never delays or cancels the next head refresh.
    if (delayMs === REFRESH_MS) reportCheckpoint(client).catch((error: unknown) => { console.error('[verifier] light client checkpoint read failed:', clean(message(error))) })
  }

  /** Asks the servers this client talks to for the time, and sets the lead to what they said: 0 takes it back. `undefined`, with the lead kept, when they cannot tell. */
  const measureLead = async (): Promise<number | undefined> => {
    lastMeasuredAt = performance.now()
    let lead: number | undefined
    try {
      lead = await measureClockLead([config.consensusRpc, ...config.executionRpcs], fetch)
    } catch {
      lead = undefined
    }
    // The jump check starts from the moment of this measurement, so a clock set between it and the next refresh is seen.
    clockJump()
    if (lead !== undefined) {
      setHeliosClockLead(lead)
      recheckDue = false
    }
    return lead
  }

  /** Asks the servers again when the lead may be wrong: the system clock was set back (whatever the lead), or set forward or woke up with a lead lent, or a measurement is still due. A measurement that could not be made keeps the lead and is tried again at most once a `REFRESH_MS`: the network may simply be down, as after the computer wakes. */
  const recheckClock = async (): Promise<void> => {
    const jump = clockJump()
    if (jump < 0 || (jump > 0 && heliosClockLead() !== 0)) recheckDue = true
    if (recheckDue && performance.now() - lastMeasuredAt >= REFRESH_MS) await measureLead()
  }

  const run = async (attempt: number): Promise<void> => {
    setState({ state: 'syncing', since: Date.now() })
    try {
      await checkChain()
      const { createHeliosProvider } = await import('@a16z/helios')
      const client = await createHeliosProvider({ executionRpc: names.execution, consensusRpc: names.consensus, checkpoint: config.checkpoint, network: 'mainnet', dbType: 'config' }, 'ethereum') as unknown as Helios
      helios = client
      await withTimeout(client.waitSynced(), SYNC_TIMEOUT_MS, 'syncing')
      await refreshHead(client)
      scheduleRefresh(client, REFRESH_MS)
    } catch (error) {
      const failed = helios
      helios = undefined
      await failed?.destroy().catch(() => {})
      const behind = clockBehind(error)
      const headAgeSeconds = outOfSync(error)
      const ahead = headAgeSeconds !== undefined
      // A lead already lent can be the cause too: one that is too large makes Helios fail with another text.
      const measured = behind || ahead || heliosClockLead() !== 0 ? await measureLead() : undefined
      const lent = measured !== undefined && ((behind && measured > 0) || (ahead && measured < 0))
      if (lent) {
        console.error(`[verifier] this computer's clock is about ${String(Math.round(Math.abs(measured) / 1000))} s ${measured > 0 ? 'behind' : 'ahead of'} the servers'; the light client allows for it`)
        // The first try with the clock lent starts at once; one that fails again goes by the ordinary backoff.
        if (!clockRetried) {
          clockRetried = true
          void run(attempt)
          return
        }
      }
      const delay = Math.min(FIRST_RETRY_MS * 2 ** attempt, MAX_RETRY_MS)
      const foldTrouble = (text: string): string => { const trouble = ownTrouble(); return trouble === undefined ? text : `${trouble} (${text})` }
      synced = new Promise<void>((resolve) => { markSynced = resolve })
      // Plain words stand in for Helios's text where the clock may be the cause and the servers could not say; where they say it is right, a head too old is a server's.
      const reason = behind && measured === undefined ? CLOCK_BEHIND_REASON : ahead && measured === undefined ? CLOCK_AHEAD_REASON : ahead && measured === 0 ? serverBehindReason(headAgeSeconds) : foldTrouble(clean(message(error)))
      setState({ state: 'failed', reason, retryAt: Date.now() + delay, ...(bootstrapMissing(error) && { bootstrapMissing: true as const }) })
      setTimeout(() => { void run(attempt + 1) }, delay).unref()
    }
  }
  let begun = false
  const begin = (): void => {
    if (begun) return
    begun = true
    void run(0)
  }
  if (pace.startAfterMs <= 0) begin()
  else setTimeout(begin, pace.startAfterMs).unref()

  return {
    status: () => state,
    provider: {
      request: async (args) => {
        begin()
        // A failed client retries on its own schedule, so waiting here would only delay the answer.
        if (state.state === 'starting' || state.state === 'syncing') await withTimeout(synced, pace.syncWaitMs, 'syncing').catch(() => {})
        const client = helios
        const now = state
        if (client === undefined || now.state !== 'synced') throw new ResolutionError('not-synced', notSyncedReason(now))
        try {
          return await client.request(args)
        } catch (error) {
          throw heliosError(cleaned(error))
        }
      }
    }
  }
}
