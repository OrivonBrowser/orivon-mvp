// One Nym tunnel per SOCKS5 user name, so each routed app has its own mixnet client and exit address. A tunnel
// starts at its app's first request (the request waits for it), is closed after ten minutes with nothing using it,
// and at most `cap` live at once: past that a new app is refused, never given another app's tunnel. README.md's
// Design notes say why.

/** A raw TCP stream through the mixnet, as the module's `connectTcp` hands it back. */
export interface TcpStream {
  /** The next chunk, or null once the far end has closed. */
  read: () => Promise<Uint8Array | null>
  write: (bytes: Uint8Array) => Promise<void>
  close: () => Promise<void>
}

export interface UdpDatagram {
  readonly data: Uint8Array
  readonly host: string
  readonly port: number
}

/** A UDP socket through the mixnet. `close` does not wake a `recv` that is waiting. */
export interface UdpChannel {
  sendTo: (host: string, port: number, bytes: Uint8Array) => Promise<unknown>
  recv: (timeoutMs?: number) => Promise<UdpDatagram>
  close: () => void
}

/** One running tunnel: what the module offers once `setupMixTunnel` has resolved. */
export interface Tunnel {
  connectTcp: (host: string, port: number) => Promise<TcpStream>
  bindUdp: () => Promise<UdpChannel>
  disconnect: () => Promise<void>
}

export type AcquireFailure = 'cap' | 'start-failed' | 'start-timeout'

/** Why a request got no tunnel: `cap` is a refusal, the others are a tunnel that did not come up. */
export class AcquireError extends Error {
  constructor (readonly kind: AcquireFailure, message: string) {
    super(message)
  }
}

/** A tunnel held for a stream or an association: released when that ends. */
export interface Lease {
  readonly tunnel: Tunnel
  release: () => void
}

export interface InstancesSnapshot {
  readonly connecting: number
  readonly ready: number
  /** How many tunnels this process has started, closed ones included: each left a module instance in memory. */
  readonly started: number
  /** Why the latest tunnel could not come up or was refused; cleared when a later one is ready. */
  readonly problem?: string
}

export interface InstancesDeps {
  /** Starts a tunnel for the user name `id`. */
  readonly start: (id: string) => Promise<Tunnel>
  readonly cap: number
  /** How long a request waits for its tunnel to come up. */
  readonly startWaitMs: number
  /** How long a tunnel nothing uses is kept. */
  readonly idleMs: number
  readonly onChange: (snapshot: InstancesSnapshot) => void
}

/** The longest `problem` text, so that main accepts the message it is in (protocol.ts's limit is 500). */
const MAX_PROBLEM = 400
export const DEFAULT_START_WAIT_MS = 30_000
export const DEFAULT_IDLE_MS = 10 * 60_000

interface Entry {
  readonly id: string
  readonly starting: Promise<Tunnel>
  tunnel?: Tunnel
  leases: number
  idleSince: number
  idleTimer?: ReturnType<typeof setTimeout>
  gone: boolean
}

export interface Instances {
  /** Resolves with a lease on the tunnel of `id`, starting it if need be; rejects with an `AcquireError`. */
  acquire: (id: string) => Promise<Lease>
  /** Closes every tunnel. */
  closeAll: () => Promise<void>
  snapshot: () => InstancesSnapshot
}

function describe (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A reason short enough for main to accept in a message. */
function bounded (text: string): string {
  return text.length > MAX_PROBLEM ? `${text.slice(0, MAX_PROBLEM - 1)}…` : text
}

export function createInstances (deps: InstancesDeps): Instances {
  const entries = new Map<string, Entry>()
  let problem: string | undefined
  let started = 0

  const snapshot = (): InstancesSnapshot => {
    let ready = 0
    let connecting = 0
    for (const entry of entries.values()) {
      if (entry.tunnel === undefined) connecting += 1
      else ready += 1
    }
    return { connecting, ready, started, ...(problem === undefined ? {} : { problem }) }
  }
  const changed = (): void => { deps.onChange(snapshot()) }

  const retire = (entry: Entry): void => {
    if (entry.gone) return
    entry.gone = true
    clearTimeout(entry.idleTimer)
    if (entries.get(entry.id) === entry) entries.delete(entry.id)
    const tunnel = entry.tunnel
    if (tunnel !== undefined) tunnel.disconnect().catch((error: unknown) => { console.error('[nym-tunnel] closing a tunnel failed:', describe(error)) })
    changed()
  }

  const armIdle = (entry: Entry): void => {
    clearTimeout(entry.idleTimer)
    entry.idleSince = Date.now()
    entry.idleTimer = setTimeout(() => { retire(entry) }, deps.idleMs)
    entry.idleTimer.unref()
  }

  /** Room for one more: the tunnel idle longest goes if every slot is taken and some tunnel has nobody on it. */
  const makeRoom = (): boolean => {
    if (entries.size < deps.cap) return true
    let oldest: Entry | undefined
    for (const entry of entries.values()) {
      if (entry.tunnel === undefined || entry.leases > 0) continue
      if (oldest === undefined || entry.idleSince < oldest.idleSince) oldest = entry
    }
    if (oldest === undefined) return false
    retire(oldest)
    return true
  }

  const begin = (id: string): Entry => {
    started += 1
    const starting = deps.start(id)
    const entry: Entry = { id, starting, leases: 0, idleSince: Date.now(), gone: false }
    entries.set(id, entry)
    starting.then(
      (tunnel) => {
        if (entry.gone) { tunnel.disconnect().catch(() => {}); return }
        entry.tunnel = tunnel
        problem = undefined
        if (entry.leases === 0) armIdle(entry)
        changed()
      },
      (error: unknown) => {
        if (entry.gone) return
        problem = bounded(`a Nym tunnel could not come up: ${describe(error)}`)
        retire(entry)
      }
    )
    changed()
    return entry
  }

  const acquire = async (id: string): Promise<Lease> => {
    let entry = entries.get(id)
    if (entry === undefined) {
      if (!makeRoom()) {
        problem = `${String(deps.cap)} apps already have a Nym tunnel open, which is the most this computer keeps; another can start once one has been idle for a while`
        changed()
        throw new AcquireError('cap', problem)
      }
      entry = begin(id)
    }
    const waiting = entry
    // Holding the entry while it starts keeps it from being taken as idle, and a lease on a tunnel that fails is dropped with it.
    waiting.leases += 1
    clearTimeout(waiting.idleTimer)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const tunnel = await Promise.race([
        waiting.starting,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new AcquireError('start-timeout', `the Nym tunnel did not come up within ${String(Math.round(deps.startWaitMs / 1000))} s`)) }, deps.startWaitMs) })
      ])
      if (waiting.gone) throw new AcquireError('start-failed', 'the Nym tunnel was closed while it started')
      let released = false
      return {
        tunnel,
        release: () => {
          if (released) return
          released = true
          waiting.leases -= 1
          if (waiting.leases === 0 && !waiting.gone) armIdle(waiting)
        }
      }
    } catch (error) {
      waiting.leases -= 1
      if (waiting.leases === 0 && !waiting.gone && waiting.tunnel !== undefined) armIdle(waiting)
      if (error instanceof AcquireError) throw error
      throw new AcquireError('start-failed', describe(error))
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    acquire,
    snapshot,
    closeAll: async () => {
      const all = [...entries.values()]
      for (const entry of all) clearTimeout(entry.idleTimer)
      await Promise.all(all.map(async (entry) => {
        entry.gone = true
        entries.delete(entry.id)
        const tunnel = entry.tunnel ?? await entry.starting.catch(() => undefined)
        await tunnel?.disconnect().catch(() => {})
      }))
      changed()
    }
  }
}
