// wasi:io's streams and pollables, and the addresses the socket interfaces
// convert, driven the way jco's glue calls them.

import { describe, expect, it } from 'vitest'
import { ResolvedNames, formatAddress, parseAddress, socketErrorCode } from '../addresses.js'
import { ComponentExit, exit, monotonicClock } from '../basics.js'
import { CLOSED, InputStream, IoError, OutputStream, poll } from '../io.js'

function source (chunks: Uint8Array[]): () => Promise<Uint8Array> {
  return async () => chunks.shift() ?? new Uint8Array(0)
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

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
