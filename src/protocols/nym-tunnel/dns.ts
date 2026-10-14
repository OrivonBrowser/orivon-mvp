// Name lookups for one Nym tunnel: A (then AAAA) queries sent as datagrams through the tunnel's own UDP, so the tunnel's
// exit asks the resolver and nothing is looked up on this computer. The module's own lookup holds one lock for the whole
// of a query, which makes every new name wait behind the one before it and a lost datagram stall them all for 30 s;
// README.md's Design notes say why this host asks for itself.

import { randomInt } from 'node:crypto'
import { isIP } from 'node:net'
import type { UdpChannel } from './instances.js'

export class DnsError extends Error {
  constructor (readonly kind: 'no-such-name' | 'timeout' | 'invalid' | 'closed', message: string) {
    super(message)
  }
}

export interface Resolver {
  /** The address of `host`; a literal address comes back as it is. Rejects with a `DnsError`. */
  resolve: (host: string) => Promise<string>
  close: () => void
}

export interface ResolverOptions {
  /** Binds the tunnel's datagram socket; called when the first name is asked for, and again if the socket has failed. */
  readonly bind: () => Promise<UdpChannel>
  /** The resolver asked first, and the one asked when it has been quiet for `attemptMs`. */
  readonly primary?: string
  readonly fallback?: string
  /** How long a query goes unanswered before it is sent again, to the other resolver. */
  readonly attemptMs?: number
  /** How long a name is tried before the lookup fails. */
  readonly totalMs?: number
  readonly now?: () => number
}

const DNS_PORT = 53
const TYPE_A = 1
const TYPE_AAAA = 28
const RCODE_NXDOMAIN = 3
export const DEFAULT_PRIMARY = '8.8.8.8'
export const DEFAULT_FALLBACK = '1.1.1.1'
export const DEFAULT_ATTEMPT_MS = 3_000
export const DEFAULT_TOTAL_MS = 12_000
/** An answer is kept for its own lifetime, within these bounds: a name that moves is found again, and a busy one is not asked for twice in a page load. */
const MIN_TTL_S = 30
const MAX_TTL_S = 300
const MAX_CACHED = 512
/** How long a receive waits before the socket is looked at again: a closed socket cannot wake one. */
const RECEIVE_SLICE_MS = 5_000
const MAX_RECEIVE_ERRORS = 5

interface Query {
  readonly id: number
  readonly name: string
  readonly type: number
  readonly accept: (answer: Answer) => void
}

interface Answer {
  readonly rcode: number
  readonly addresses: readonly string[]
  readonly ttl: number
}

function encodeQuery (id: number, name: string, type: number): Buffer {
  const labels = name.replace(/\.$/, '').split('.')
  const parts: Buffer[] = [Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0])]
  let length = 0
  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8')
    if (bytes.length === 0 || bytes.length > 63) throw new DnsError('invalid', `${name} is not a name that can be looked up`)
    length += bytes.length + 1
    parts.push(Buffer.from([bytes.length]), bytes)
  }
  if (length > 253) throw new DnsError('invalid', `${name} is not a name that can be looked up`)
  parts.push(Buffer.from([0, type >> 8, type & 0xff, 0, 1]))
  return Buffer.concat(parts)
}

/** The offset after the name at `offset`, or -1 when it runs past the message; a compression pointer ends a name. */
function skipName (message: Buffer, offset: number): number {
  let at = offset
  for (let hops = 0; hops < 128; hops += 1) {
    const length = message[at]
    if (length === undefined) return -1
    if (length === 0) return at + 1
    if ((length & 0xc0) === 0xc0) return at + 2 <= message.length ? at + 2 : -1
    at += length + 1
  }
  return -1
}

function formatAddress (bytes: Buffer): string {
  if (bytes.length === 4) return [...bytes].join('.')
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16))
  return groups.join(':')
}

/** What a response says of the question it answers: its id, the name it asks, its code, and every address of `type` it holds; undefined for bytes that are not a response. */
export function parseResponse (message: Buffer, type: number): { id: number, name: string, answer: Answer } | undefined {
  if (message.length < 12 || (message[2] ?? 0) < 0x80) return undefined
  const id = message.readUInt16BE(0)
  const rcode = (message[3] ?? 0) & 0x0f
  const questions = message.readUInt16BE(4)
  const answers = message.readUInt16BE(6)
  let at = 12
  let name = ''
  for (let i = 0; i < questions; i += 1) {
    if (i === 0) {
      const labels: string[] = []
      let cursor = at
      while (message[cursor] !== undefined && message[cursor] !== 0 && ((message[cursor] ?? 0) & 0xc0) === 0) {
        const length = message[cursor] ?? 0
        labels.push(message.subarray(cursor + 1, cursor + 1 + length).toString('utf8'))
        cursor += length + 1
      }
      name = labels.join('.').toLowerCase()
    }
    const end = skipName(message, at)
    if (end < 0 || end + 4 > message.length) return undefined
    at = end + 4
  }
  const addresses: string[] = []
  let ttl = MAX_TTL_S
  for (let i = 0; i < answers; i += 1) {
    const end = skipName(message, at)
    if (end < 0 || end + 10 > message.length) return undefined
    const kind = message.readUInt16BE(end)
    const lifetime = message.readUInt32BE(end + 4)
    const size = message.readUInt16BE(end + 8)
    const data = message.subarray(end + 10, end + 10 + size)
    if (data.length !== size) return undefined
    if (kind === type && size === (type === TYPE_A ? 4 : 16)) {
      addresses.push(formatAddress(data))
      ttl = Math.min(ttl, lifetime)
    }
    at = end + 10 + size
  }
  return { id, name, answer: { rcode, addresses, ttl } }
}

export function createResolver (options: ResolverOptions): Resolver {
  const primary = options.primary ?? DEFAULT_PRIMARY
  const fallback = options.fallback ?? DEFAULT_FALLBACK
  const attemptMs = options.attemptMs ?? DEFAULT_ATTEMPT_MS
  const totalMs = options.totalMs ?? DEFAULT_TOTAL_MS
  const now = options.now ?? Date.now
  const cache = new Map<string, { readonly address: string, readonly expires: number }>()
  const asking = new Map<string, Promise<string>>()
  const pending = new Map<number, Query>()
  let channel: Promise<UdpChannel> | undefined
  let closed = false

  const receive = async (udp: UdpChannel): Promise<void> => {
    let failures = 0
    while (!closed) {
      try {
        const datagram = await udp.recv(RECEIVE_SLICE_MS)
        failures = 0
        if (datagram.port !== DNS_PORT || (datagram.host !== primary && datagram.host !== fallback)) continue
        const bytes = Buffer.from(datagram.data)
        const query = bytes.length < 2 ? undefined : pending.get(bytes.readUInt16BE(0))
        if (query === undefined) continue
        const response = parseResponse(bytes, query.type)
        if (response !== undefined && response.name === query.name) query.accept(response.answer)
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        if (closed || text.includes('closed')) break
        if (text.includes('timed out')) continue
        failures += 1
        if (failures >= MAX_RECEIVE_ERRORS) break
        await new Promise<void>((resolve) => { setTimeout(resolve, 200) })
      }
    }
    // A socket that stopped is replaced by the next lookup, not kept.
    if (channel !== undefined) channel = undefined
  }

  const socket = async (): Promise<UdpChannel> => {
    if (channel === undefined) {
      const bound = options.bind()
      channel = bound
      bound.then((udp) => { void receive(udp) }, () => { if (channel === bound) channel = undefined })
    }
    return await channel
  }

  const unusedId = (): number => {
    for (;;) {
      const id = randomInt(0, 0x10000)
      if (!pending.has(id)) return id
    }
  }

  /** One question, sent to the primary, again to the fallback after `attemptMs` of quiet, and again to the primary; the first answer that says something wins. */
  const ask = async (name: string, type: number): Promise<Answer> => {
    const udp = await socket()
    const id = unusedId()
    return await new Promise<Answer>((resolve, reject) => {
      const timers: Array<ReturnType<typeof setTimeout>> = []
      const done = (): void => { for (const timer of timers) clearTimeout(timer); pending.delete(id) }
      const send = (server: string): void => {
        try {
          udp.sendTo(server, DNS_PORT, encodeQuery(id, name, type)).catch(() => {})
        } catch (error) {
          done()
          reject(error instanceof DnsError ? error : new DnsError('closed', 'the tunnel cannot send a datagram'))
        }
      }
      pending.set(id, {
        id,
        name: name.toLowerCase(),
        type,
        // SERVFAIL and the like say nothing about the name: the other resolver is still waited for.
        accept: (answer) => { if (answer.rcode === 0 || answer.rcode === RCODE_NXDOMAIN) { done(); resolve(answer) } }
      })
      send(primary)
      timers.push(setTimeout(() => { send(fallback) }, attemptMs))
      timers.push(setTimeout(() => { send(primary) }, attemptMs * 2))
      timers.push(setTimeout(() => { done(); reject(new DnsError('timeout', `no resolver answered for ${name} within ${String(Math.round(totalMs / 1000))} s`)) }, totalMs))
    })
  }

  const lookup = async (host: string): Promise<string> => {
    const first = await ask(host, TYPE_A)
    if (first.rcode === RCODE_NXDOMAIN) throw new DnsError('no-such-name', `${host} does not exist`)
    let answer = first
    if (first.addresses.length === 0) {
      answer = await ask(host, TYPE_AAAA)
      if (answer.rcode === RCODE_NXDOMAIN) throw new DnsError('no-such-name', `${host} does not exist`)
    }
    const address = answer.addresses[0]
    if (address === undefined) throw new DnsError('no-such-name', `${host} has no address`)
    if (cache.size >= MAX_CACHED) { const oldest = cache.keys().next().value; if (oldest !== undefined) cache.delete(oldest) }
    cache.set(host, { address, expires: now() + Math.min(Math.max(answer.ttl, MIN_TTL_S), MAX_TTL_S) * 1000 })
    return address
  }

  return {
    resolve: async (host) => {
      if (closed) throw new DnsError('closed', 'the tunnel is closed')
      if (isIP(host) !== 0) return host
      const key = host.toLowerCase()
      const kept = cache.get(key)
      if (kept !== undefined && kept.expires > now()) return kept.address
      let running = asking.get(key)
      if (running === undefined) {
        running = lookup(key).finally(() => { asking.delete(key) })
        asking.set(key, running)
      }
      return await running
    },
    close: () => {
      closed = true
      for (const query of [...pending.values()]) pending.delete(query.id)
      void channel?.then((udp) => { udp.close() }, () => {})
    }
  }
}
