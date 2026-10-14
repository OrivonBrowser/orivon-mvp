import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StallError } from '../instances.js'
import type { TcpStream, UdpChannel, UdpDatagram } from '../instances.js'
import { loadNymModule } from '../module-loader.js'
import { MODULE_GLUE, MODULE_WASM } from '../protocol.js'
import type { PinnedFile } from '../protocol.js'

const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
const GLUE = Buffer.from('// a glue the test imports its own way\n')

interface Fake {
  readonly clientIds: string[]
  readonly options: Array<Record<string, unknown>>
  readonly connected: string[]
  readonly udp: { sent: Array<{ host: string, bytes: Buffer }>, closed: boolean, deliver: (datagram: UdpDatagram) => void }
  disconnects: number
  /** An error `connectTcp` throws, when set. */
  connectError?: string
  /** What each call of `setupMixTunnel` does, in order; after the list, it succeeds. */
  setups: Array<'fail' | 'hang' | 'ok'>
}

function fakeModule (fake: Fake): unknown {
  const inbox: UdpDatagram[] = []
  let wake: (() => void) | undefined
  fake.udp.deliver = (datagram) => { inbox.push(datagram); wake?.() }
  return {
    initSync: () => {},
    main: () => {},
    setupMixTunnel: async (options: { clientId: string }) => {
      fake.clientIds.push(options.clientId)
      fake.options.push(options)
      const how = fake.setups.shift() ?? 'ok'
      if (how === 'fail') throw new Error('gateway selection error')
      if (how === 'hang') await new Promise<never>(() => {})
    },
    connectTcp: async (host: string): Promise<TcpStream> => {
      if (fake.connectError !== undefined) throw new Error(fake.connectError)
      fake.connected.push(host)
      return { read: async () => null, write: async () => {}, close: async () => {} }
    },
    bindUdp: async (): Promise<UdpChannel> => ({
      sendTo: async (host, _port, bytes) => { fake.udp.sent.push({ host, bytes: Buffer.from(bytes) }) },
      recv: async () => {
        while (inbox.length === 0) {
          if (fake.udp.closed) throw new Error('UDP socket closed')
          await new Promise<void>((resolve) => { wake = resolve })
        }
        return inbox.shift() as UdpDatagram
      },
      close: () => { fake.udp.closed = true; wake?.() }
    }),
    disconnectMixTunnel: async () => { fake.disconnects += 1 }
  }
}

function newFake (setups: Fake['setups'] = []): Fake {
  return { clientIds: [], options: [], connected: [], udp: { sent: [], closed: false, deliver: () => {} }, disconnects: 0, setups }
}

function pin (name: string, bytes: Buffer): PinnedFile {
  return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

let dir = ''

async function load (fake: Fake, seams: { startTimeoutMs?: number, breakUdp?: boolean } = {}) {
  await writeFile(join(dir, MODULE_GLUE), GLUE)
  await writeFile(join(dir, MODULE_WASM), WASM)
  const { breakUdp, ...loader } = seams
  return await loadNymModule(dir, [pin(MODULE_GLUE, GLUE), pin(MODULE_WASM, WASM)], {
    importGlue: async () => { const made = fakeModule(fake) as { bindUdp: () => Promise<UdpChannel> }; if (breakUdp === true) made.bindUdp = async () => { throw new Error('no datagram socket') }; return made },
    compile: async () => ({} as WebAssembly.Module),
    ...loader
  })
}

/** A response to the query in `bytes`, from `host`, carrying `address`. */
function answer (query: Buffer, host: string, address: number[]): UdpDatagram {
  let end = 12
  while (query[end] !== 0) end += (query[end] ?? 0) + 1
  const question = query.subarray(12, end + 5)
  const record = Buffer.concat([Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4]), Buffer.from(address)])
  const header = Buffer.from([query[0] ?? 0, query[1] ?? 0, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0])
  return { host, port: 53, data: new Uint8Array(Buffer.concat([header, question, record])) }
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-nym-loader-')) })
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }) })

describe('bringing a tunnel up', () => {
  it('tries again with a new identity when the first gateway fails, and says nothing of it once the second works', async () => {
    const fake = newFake(['fail', 'ok'])
    const module = await load(fake)
    const tunnel = await module.start('app-a', 'balanced')
    expect(tunnel).toBeDefined()
    expect(fake.clientIds).toHaveLength(2)
    expect(new Set(fake.clientIds).size, 'the second attempt is another identity, so another gateway is picked').toBe(2)
    expect(fake.clientIds.every((id) => id.startsWith('app-a-'))).toBe(true)
    expect(fake.disconnects, 'the failed attempt was closed').toBe(1)
    expect(module.instances(), 'both attempts left an instance in memory, and are counted').toBe(2)
  })

  it('passes each privacy level\'s options to the module: balanced has no steady stream and keeps loop cover traffic, strongest is Nym\'s default', async () => {
    const fake = newFake()
    const module = await load(fake)
    await module.start('app-a', 'balanced')
    await module.start('app-b', 'strongest')
    expect(fake.options.map(({ clientId: _id, ...rest }) => rest)).toEqual([
      { disablePoissonTraffic: true, disableCoverTraffic: false },
      { disablePoissonTraffic: false, disableCoverTraffic: false }
    ])
  })

  it('keeps the level for a tunnel that is tried again', async () => {
    const fake = newFake(['fail', 'ok'])
    await (await load(fake)).start('app-a', 'strongest')
    expect(fake.options.map((options) => options['disablePoissonTraffic'])).toEqual([false, false])
  })

  it('fails with the last reason after three attempts', async () => {
    const fake = newFake(['fail', 'fail', 'fail', 'ok'])
    const module = await load(fake)
    await expect(module.start('app-a', 'balanced')).rejects.toThrow('gateway selection error')
    expect(fake.clientIds).toHaveLength(3)
  })

  it('gives up on an attempt that is slow and starts the next, within the time each attempt is given', async () => {
    vi.useFakeTimers()
    const fake = newFake(['hang', 'ok'])
    const module = await load(fake, { startTimeoutMs: 20_000 })
    const starting = module.start('app-a', 'balanced')
    await vi.advanceTimersByTimeAsync(19_000)
    expect(fake.clientIds).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_500)
    await starting
    expect(fake.clientIds).toHaveLength(2)
  })
})

describe('a tunnel the module brought up', () => {
  it('has the name looked up through its own datagrams, and hands the module the address', async () => {
    const fake = newFake()
    const tunnel = await (await load(fake)).start('app-a', 'balanced')
    const opening = tunnel.connectTcp('service.example', 443)
    await vi.waitFor(() => { expect(fake.udp.sent).toHaveLength(1) })
    expect(fake.udp.sent[0]?.host).toBe('8.8.8.8')
    fake.udp.deliver(answer(fake.udp.sent[0]?.bytes as Buffer, '8.8.8.8', [203, 0, 113, 7]))
    await opening
    expect(fake.connected, 'the module is never asked to look a name up: that lookup holds every other one back').toEqual(['203.0.113.7'])
  })

  it('opens an address without a lookup', async () => {
    const fake = newFake()
    const tunnel = await (await load(fake)).start('app-a', 'balanced')
    await tunnel.connectTcp('203.0.113.9', 443)
    expect(fake.connected).toEqual(['203.0.113.9'])
    expect(fake.udp.sent).toHaveLength(0)
  })

  it('calls a name nobody answered for a stall of the tunnel, not a refusal of the name', async () => {
    vi.useFakeTimers()
    const fake = newFake()
    const tunnel = await (await load(fake)).start('app-a', 'balanced')
    const failed = tunnel.connectTcp('silent.example', 443).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(13_000)
    expect(await failed).toBeInstanceOf(StallError)
    expect(fake.connected).toEqual([])
  })

  it('calls the module\'s own connect timeout a refusal of the destination, which a destination can cause by itself', async () => {
    const fake = newFake()
    fake.connectError = 'TCP connect timed out'
    const tunnel = await (await load(fake)).start('app-a', 'balanced')
    await expect(tunnel.connectTcp('203.0.113.9', 443)).rejects.not.toBeInstanceOf(StallError)
  })

  it('calls a datagram socket that cannot be bound a stall of the tunnel too', async () => {
    const fake = newFake()
    const tunnel = await (await load(fake, { breakUdp: true })).start('app-a', 'balanced')
    await expect(tunnel.connectTcp('anything.example', 443)).rejects.toBeInstanceOf(StallError)
  })

  it('calls a name that does not exist a refusal', async () => {
    const fake = newFake()
    const tunnel = await (await load(fake)).start('app-a', 'balanced')
    const failed = tunnel.connectTcp('nothing.example', 443).catch((error: unknown) => error)
    await vi.waitFor(() => { expect(fake.udp.sent).toHaveLength(1) })
    const query = fake.udp.sent[0]?.bytes as Buffer
    const response = answer(query, '8.8.8.8', [1, 2, 3, 4])
    const bytes = Buffer.from(response.data)
    bytes[3] = 0x83
    bytes.writeUInt16BE(0, 6)
    fake.udp.deliver({ ...response, data: new Uint8Array(bytes.subarray(0, bytes.length - 16)) })
    const error = await failed
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(StallError)
  })

  it('closes its datagram socket and the module when it is disconnected', async () => {
    const fake = newFake()
    const tunnel = await (await load(fake)).start('app-a', 'balanced')
    const opening = tunnel.connectTcp('service.example', 443)
    await vi.waitFor(() => { expect(fake.udp.sent).toHaveLength(1) })
    fake.udp.deliver(answer(fake.udp.sent[0]?.bytes as Buffer, '8.8.8.8', [203, 0, 113, 7]))
    await opening
    await tunnel.disconnect()
    await vi.waitFor(() => { expect(fake.udp.closed).toBe(true) })
    expect(fake.disconnects).toBe(1)
  })
})
