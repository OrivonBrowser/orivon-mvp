// wasi:io's streams and pollables, and the addresses the socket interfaces
// convert, driven the way jco's glue calls them.

import { describe, expect, it, vi } from 'vitest'
import { ResolvedNames, formatAddress, parseAddress, reportedAddress, socketErrorCode } from '../addresses.js'
import { ComponentExit, exit, monotonicClock } from '../basics.js'
import { componentImports } from '../imports.js'
import { CLOSED, InputStream, IoError, OutputStream, Pollable, poll } from '../io.js'

function source (chunks: Uint8Array[]): () => Promise<Uint8Array> {
  return async () => chunks.shift() ?? new Uint8Array(0)
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** A pollable that becomes ready, and settles its wait, when `open` is called. */
function gate (): { readonly pollable: Pollable, readonly open: () => void } {
  let ready = false
  let release: () => void = () => {}
  const opened = new Promise<void>((resolve) => { release = resolve })
  return { pollable: new Pollable(() => ready, async () => { await opened }), open: () => { ready = true; release() } }
}

const after = async (ms: number): Promise<void> => { await new Promise<void>((resolve) => setTimeout(resolve, ms)) }

describe('InputStream', () => {
  it('answers a non-blocking read from what has arrived, empty until then, and closed at the end', async () => {
    const stream = new InputStream(source([bytes('hello')]))
    expect(stream.read(10n)).toEqual(new Uint8Array(0))
    await stream.subscribe().block()
    expect(new TextDecoder().decode(stream.read(3n))).toBe('hel')
    expect(new TextDecoder().decode(await stream.blockingRead(10n))).toBe('lo')
    await expect(stream.blockingRead(10n)).rejects.toBe(CLOSED)
  })

  it('reports a failed source as last-operation-failed, with the code the interface names it by', async () => {
    const stream = new InputStream(async () => { throw Object.assign(new Error('gone'), { code: 'reset' }) }, () => ({ kind: 'network', code: 'connection-reset' }))
    const error = await stream.blockingRead(4n).catch((thrown: unknown) => thrown) as { tag: string, val: IoError }
    expect(error.tag).toBe('last-operation-failed')
    expect(error.val.toDebugString()).toBe('gone')
    expect(error.val.codeFor('network')).toBe('connection-reset')
    expect(error.val.codeFor('filesystem')).toBeUndefined()
  })
})

describe('OutputStream', () => {
  it('permits a write while nothing is in flight, and none until the sink has taken it', async () => {
    const taken: string[] = []
    let release: () => void = () => {}
    const stream = new OutputStream(async (data) => { await new Promise<void>((resolve) => { release = resolve }); taken.push(new TextDecoder().decode(data)) })
    expect(stream.checkWrite()).toBe(65_536n)
    stream.write(bytes('one'))
    expect(stream.checkWrite()).toBe(0n)
    expect(() => { stream.write(bytes('two')) }).toThrow(TypeError)
    expect(stream.subscribe().ready()).toBe(false)
    release()
    await stream.blockingFlush()
    expect(taken).toEqual(['one'])
    expect(stream.checkWrite()).toBe(65_536n)
  })

  it('writes and flushes in one blocking call, splitting what exceeds the budget', async () => {
    const sizes: number[] = []
    const stream = new OutputStream(async (data) => { sizes.push(data.length) })
    await stream.blockingWriteAndFlush(new Uint8Array(70_000))
    expect(sizes).toEqual([65_536, 4_464])
  })

  it('accepts an empty write while another is in flight, so an empty splice returns 0 rather than trapping', () => {
    const stream = new OutputStream(async () => await new Promise(() => {}))
    stream.write(bytes('busy'))
    expect(() => { stream.write(new Uint8Array(0)) }).not.toThrow()
    expect(stream.splice(new InputStream(async () => new Uint8Array(0)), 10n)).toBe(0n)
  })

  it('keeps the copy it writes, so the caller may reuse its buffer', async () => {
    const seen: string[] = []
    const stream = new OutputStream(async (data) => { await Promise.resolve(); seen.push(new TextDecoder().decode(data)) })
    const buffer = bytes('abc')
    stream.write(buffer)
    buffer.set(bytes('xyz'))
    await stream.blockingFlush()
    expect(seen).toEqual(['abc'])
  })
})

describe('poll', () => {
  it('waits for the first pollable to be ready and names each one that is', async () => {
    const soon = monotonicClock.subscribeDuration(5_000_000n)
    const later = monotonicClock.subscribeDuration(10_000_000_000n)
    expect([...await poll([later, soon])]).toEqual([1])
    await expect(poll([])).rejects.toThrow(TypeError)
  })

  // A guest's event loop polls every socket each time anything wakes it; a reaction left on an idle socket's pending promise by each poll grew a busy program to gigabytes.
  it('waits on a pollable that stays pending once, however often it is polled with others', async () => {
    const idle = new Promise<void>(() => {})
    const waitedOn = vi.fn(async () => { await idle })
    const quiet = new Pollable(() => false, waitedOn)
    let ticks = 0
    const busy = new Pollable(() => ticks > 0, async () => { await Promise.resolve() })
    for (let round = 0; round < 200; round++) {
      ticks = 0
      const waiting = poll([quiet, busy])
      ticks = 1
      expect([...await waiting]).toEqual([1])
    }
    expect(waitedOn.mock.calls.length).toBe(1)
  })

  it('wakes every poll waiting on one pollable, and arms its wait again afterwards', async () => {
    let ready = false
    let release: () => void = () => {}
    let waits = 0
    const gate = new Pollable(() => ready, async () => { waits++; await new Promise<void>((resolve) => { release = resolve }) })
    const first = poll([gate])
    const second = poll([gate])
    ready = true
    release()
    expect([...await first]).toEqual([0])
    expect([...await second]).toEqual([0])
    ready = false
    const third = poll([gate])
    await Promise.resolve()
    expect(waits).toBe(2)
    ready = true
    release()
    await third
  })

  // A guest's event loop reads each socket that woke in one pass of the host's loop, and polls again in between: an answer per socket costs the whole scan once per socket.
  it('answers once for every pollable that became ready in the same pass of the event loop', async () => {
    const [first, second, third] = [gate(), gate(), gate()] as const
    const waiting = poll([first.pollable, second.pollable, third.pollable])
    setImmediate(first.open)
    setImmediate(third.open)
    expect([...await waiting]).toEqual([0, 2])
  })

  it('answers at once when a pollable is ready as the poll starts', async () => {
    const ready = gate()
    ready.open()
    expect([...await poll([gate().pollable, ready.pollable])]).toEqual([1])
  })

  it('adds no Set entry and no wait for each pollable a poll watches, however often it waits', async () => {
    const waitedOn = vi.fn(async () => { await new Promise<void>(() => {}) })
    const quiet = Array.from({ length: 50 }, () => new Pollable(() => false, waitedOn))
    const adds = vi.spyOn(Set.prototype, 'add')
    try {
      for (let round = 0; round < 20; round++) {
        const wake = gate()
        const waiting = poll([...quiet, wake.pollable])
        wake.open()
        expect([...await waiting]).toEqual([50])
      }
      expect(adds.mock.calls.length).toBeLessThan(40)
    } finally {
      adds.mockRestore()
    }
    expect(waitedOn.mock.calls.length).toBe(50)
  })

  it('is never woken by a pollable the program has dropped', async () => {
    const dropped = gate()
    const other = gate()
    const waiting = poll([dropped.pollable, other.pollable])
    dropped.pollable[Symbol.dispose]()
    dropped.open()
    expect(await Promise.race([waiting.then(() => 'woke'), after(30).then(() => 'still waiting')])).toBe('still waiting')
    other.open()
    expect([...await waiting]).toContain(1)
  })

  it('clears the timer of a clock pollable the program drops', () => {
    vi.useFakeTimers()
    try {
      const clock = monotonicClock.subscribeDuration(60_000_000_000n)
      void poll([clock, gate().pollable])
      expect(vi.getTimerCount()).toBe(1)
      clock[Symbol.dispose]()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  // Where there is no setImmediate, a timer would clamp the wake to 4 ms in a page's Worker.
  it('ends a pass with a message-channel task where there is no setImmediate', async () => {
    const delivered: Array<() => void> = []
    class FakeChannel {
      readonly port1: { onmessage: (() => void) | null } = { onmessage: null }
      readonly port2 = { postMessage: (): void => { delivered.push(() => { this.port1.onmessage?.() }) } }
    }
    vi.stubGlobal('setImmediate', undefined)
    vi.stubGlobal('MessageChannel', FakeChannel)
    try {
      const only = gate()
      const waiting = poll([only.pollable])
      only.open()
      await after(10)
      expect(delivered.length).toBe(1)
      delivered[0]?.()
      expect([...await waiting]).toEqual([0])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('wasi:cli/exit', () => {
  it('unwinds with an Error, which jco rethrows rather than lowering', () => {
    expect(() => exit.exit({ tag: 'err' })).toThrow(expect.objectContaining({ code: 1 }))
    expect(() => exit.exitWithCode(7)).toThrow(ComponentExit)
  })
})

describe('socket addresses', () => {
  it('parses and formats both families, with :: and an embedded IPv4', () => {
    expect(parseAddress('127.0.0.1')).toEqual({ tag: 'ipv4', val: [127, 0, 0, 1] })
    expect(parseAddress('::1')).toEqual({ tag: 'ipv6', val: [0, 0, 0, 0, 0, 0, 0, 1] })
    expect(parseAddress('::ffff:10.0.0.1')).toEqual({ tag: 'ipv6', val: [0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001] })
    expect(parseAddress('2001:db8::1')?.val).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])
    expect(parseAddress('256.0.0.1')).toBeUndefined()
    expect(parseAddress('1:2:3:4:5:6:7:8:9')).toBeUndefined()
    expect(parseAddress('example.com')).toBeUndefined()
    expect(formatAddress({ tag: 'ipv6', val: [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1] })).toBe('2001:db8:0:0:0:0:0:1')
  })

  it('reports an address of the socket\'s own family, the unspecified one when orivon.net answered the other', () => {
    expect(reportedAddress('0.0.0.0', 4001, 'ipv6')).toEqual({ tag: 'ipv6', val: { port: 4001, flowInfo: 0, address: [0, 0, 0, 0, 0, 0, 0, 0], scopeId: 0 } })
    expect(reportedAddress('::1', 4001, 'ipv4')).toEqual({ tag: 'ipv4', val: { port: 4001, address: [0, 0, 0, 0] } })
    expect(reportedAddress('::1', 4001, 'ipv6').tag).toBe('ipv6')
    expect(reportedAddress('127.0.0.1', 4001, 'ipv4').tag).toBe('ipv4')
  })

  it('maps orivon.net failures to socket error codes, the platform code first', () => {
    expect(socketErrorCode({ code: 'internal', platformCode: 'ECONNREFUSED' })).toBe('connection-refused')
    expect(socketErrorCode({ code: 'denied' })).toBe('access-denied')
    expect(socketErrorCode({ code: 'notFound' })).toBe('name-unresolvable')
    expect(socketErrorCode(new Error('?'))).toBe('unknown')
  })
})

describe('resolved names', () => {
  it('stay bounded however many names a long-lived program resolves, forgetting the least recent first', () => {
    const names = new ResolvedNames()
    const address = (index: number): { tag: 'ipv4', val: [number, number, number, number] } => ({ tag: 'ipv4', val: [10, (index >> 16) & 255, (index >> 8) & 255, index & 255] })
    for (let index = 0; index < 5_000; index++) names.remember(`host-${index}.test`, address(index))
    expect(names.hostFor(address(0))).toBe('10.0.0.0')
    expect(names.hostFor(address(4_999))).toBe('host-4999.test')
    names.remember('other.test', address(4_999))
    names.remember('host-4999.test', address(4_999))
    expect(names.hostFor(address(4_999))).toBe(formatAddress(address(4_999)))
  })
})

describe('the imports object', () => {
  it('carries every resource class WASI 0.2 declares in each interface, since a real program imports them all', () => {
    const resources: Record<string, string[]> = {
      'wasi:io/error': ['Error'],
      'wasi:io/poll': ['Pollable'],
      'wasi:io/streams': ['InputStream', 'OutputStream'],
      'wasi:filesystem/types': ['Descriptor', 'DirectoryEntryStream'],
      'wasi:sockets/network': ['Network'],
      'wasi:sockets/tcp': ['TcpSocket'],
      'wasi:sockets/udp': ['UdpSocket', 'IncomingDatagramStream', 'OutgoingDatagramStream'],
      'wasi:sockets/ip-name-lookup': ['ResolveAddressStream'],
      'wasi:cli/terminal-input': ['TerminalInput'],
      'wasi:cli/terminal-output': ['TerminalOutput']
    }
    const stream = { stdin: new InputStream(async () => new Uint8Array(0)), stdout: new OutputStream(async () => {}), stderr: new OutputStream(async () => {}) }
    const imports = componentImports({ fs: {} as never, net: {} as never, preopens: {}, args: [], env: {}, ...stream })
    for (const [iface, names] of Object.entries(resources)) {
      for (const name of names) expect(typeof imports[iface]?.[name], `${iface} ${name}`).toBe('function')
    }
  })
})
