// Helios, the Ethereum light client, behind the EIP-1193 provider the ENS
// resolver reads through. Before Helios loads, this process's global fetch
// becomes the light client's allowlisted one, and WebSocket is removed:
// Helios reaches the network only through globals, and nothing else here
// uses them. README.md's Design notes cover the two shims it needs.

import { ResolutionError } from '../resolution/records.js'
import type { WebFetch } from './egress.js'
import { heliosError } from './helios-errors.js'
import { failoverRpc } from './rpc-failover.js'
import type { FromHost, LightClientConfig, LightClientState } from './protocol.js'
import type { LightClient } from './service.js'

/** How long a `.eth` load waits for the first sync before "cannot verify yet". */
export const SYNC_WAIT_MS = 8_000
const SYNC_TIMEOUT_MS = 5 * 60_000
const FIRST_RETRY_MS = 5_000
const MAX_RETRY_MS = 5 * 60_000
const REFRESH_MS = 60_000
/** Helios falls back to a checkpoint compiled into it, about a year old, when handed a malformed one. */
const CHECKPOINT = /^0x[0-9a-f]{64}$/

interface Helios {
  request: (args: { method: string, params?: unknown }) => Promise<unknown>
  waitSynced: () => Promise<void>
  destroy: () => Promise<void>
}

function withTimeout<T> (promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<never>((_resolve, reject) => setTimeout(() => { reject(new Error(`${what} took longer than ${String(ms / 1000)} s`)) }, ms))])
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

export function startHeliosLightClient (config: LightClientConfig, fetch: WebFetch, report: (message: FromHost) => void): LightClient {
  if (!CHECKPOINT.test(config.checkpoint)) throw new Error(`not a checkpoint: ${config.checkpoint}`)
  const primary = config.executionRpcs[0]
  if (primary === undefined) throw new Error('no execution RPC configured')
  installTimerScope()
  const nodeFetch = globalThis.fetch
  const execution = failoverRpc(config.executionRpcs, fetch)
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    // Helios loads its own WASM from a data: URL through fetch; that never touches the network.
    const request = new Request(input, init)
    if (request.url.startsWith('data:application/wasm')) return await nodeFetch(request)
    // Its RPC calls arrive as Request objects: method, headers and body live on the Request, not in init.
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
    const forwarded: RequestInit = { method: request.method, headers: Object.fromEntries(request.headers), ...(body === undefined ? {} : { body }), signal: request.signal }
    const response = request.url === primary || request.url === `${primary}/` ? await execution(request.url, forwarded) : await fetch(request.url, forwarded)
    // Electron's net.fetch leaves url empty; Helios parses it, and throws from inside its WASM, ending the process.
    if (response.url === '') Object.defineProperty(response, 'url', { value: request.url })
    return response
  }) as typeof globalThis.fetch
  Object.defineProperty(globalThis, 'WebSocket', { value: undefined, configurable: true, writable: true })

  let state: LightClientState = { state: 'starting' }
  let helios: Helios | undefined
  let markSynced: () => void = () => {}
  let synced = new Promise<void>((resolve) => { markSynced = resolve })
  let lastCheckpoint: string | undefined

  const setState = (next: LightClientState): void => {
    state = next
    report({ type: 'status', status: next })
  }

  const refresh = async (client: Helios): Promise<void> => {
    const block = Number(BigInt(await client.request({ method: 'eth_blockNumber', params: [] }) as string))
    setState({ state: 'synced', block, at: Date.now() })
    const root = await client.request({ method: 'helios_getCurrentCheckpoint', params: [] })
    const timestamp = await finalizedTimestamp(client)
    if (typeof root === 'string' && timestamp !== undefined && root !== lastCheckpoint) {
      lastCheckpoint = root
      report({ type: 'checkpoint', root: root.toLowerCase(), timestamp })
    }
  }

  const run = async (attempt: number): Promise<void> => {
    setState({ state: 'syncing', since: Date.now() })
    try {
      const { createHeliosProvider } = await import('@a16z/helios')
      const client = await createHeliosProvider({ executionRpc: primary, consensusRpc: config.consensusRpc, checkpoint: config.checkpoint, network: 'mainnet', dbType: 'config' }, 'ethereum') as unknown as Helios
      helios = client
      await withTimeout(client.waitSynced(), SYNC_TIMEOUT_MS, 'syncing')
      await refresh(client)
      markSynced()
      const timer = setInterval(() => {
        refresh(client).catch((error: unknown) => { console.error('[verifier] light client refresh failed:', message(error)) })
      }, REFRESH_MS)
      timer.unref()
    } catch (error) {
      const failed = helios
      helios = undefined
      await failed?.destroy().catch(() => {})
      const delay = Math.min(FIRST_RETRY_MS * 2 ** attempt, MAX_RETRY_MS)
      synced = new Promise<void>((resolve) => { markSynced = resolve })
      setState({ state: 'failed', reason: message(error), retryAt: Date.now() + delay })
      setTimeout(() => { void run(attempt + 1) }, delay).unref()
    }
  }
  void run(0)

  return {
    status: () => state,
    provider: {
      request: async (args) => {
        if (state.state !== 'synced') await Promise.race([synced, new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_MS))])
        const client = helios
        if (client === undefined || state.state !== 'synced') {
          throw new ResolutionError('not-synced', state.state === 'failed' ? `the light client failed: ${state.reason}` : 'the light client is still syncing')
        }
        try {
          return await client.request(args)
        } catch (error) {
          throw heliosError(error)
        }
      }
    }
  }
}
