import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createResolver, DnsError, parseResponse } from '../dns.js'
import type { UdpChannel, UdpDatagram } from '../instances.js'

interface Sent { readonly host: string, readonly port: number, readonly bytes: Buffer }

/** A tunnel's datagram socket the test answers by hand. */
function fakeChannel () {
  const sent: Sent[] = []
  const inbox: UdpDatagram[] = []
  let wake: (() => void) | undefined
  let closed = false
  const channel: UdpChannel = {
    sendTo: async (host, port, bytes) => { sent.push({ host, port, bytes: Buffer.from(bytes) }) },
    recv: async () => {
      while (inbox.length === 0) {
        if (closed) throw new Error('UDP socket closed')
        await new Promise<void>((resolve) => { wake = resolve })
      }
      return inbox.shift() as UdpDatagram
    },
    close: () => { closed = true; wake?.() }
  }
  return {
    channel,
    sent,
    deliver: (datagram: UdpDatagram) => { inbox.push(datagram); wake?.() },
    isClosed: () => closed
  }
}

function nameOf (query: Buffer): string {
  const labels: string[] = []
  for (let at = 12; query[at] !== 0; at += (query[at] ?? 0) + 1) labels.push(query.subarray(at + 1, at + 1 + (query[at] ?? 0)).toString())
  return labels.join('.')
}

/** A response to `query`: its question, then the addresses (type A, or AAAA when 16 bytes long). */
function respond (query: Buffer, from: string, addresses: Array<number[]>, options: { rcode?: number, ttl?: number } = {}): UdpDatagram {
  let end = 12
  while (query[end] !== 0) end += (query[end] ?? 0) + 1
  const question = query.subarray(12, end + 5)
  const answers = addresses.map((bytes) => Buffer.concat([Buffer.from([0xc0, 12, 0, bytes.length === 4 ? 1 : 28, 0, 1]), Buffer.from([0, 0, 0, 0]), Buffer.from([0, bytes.length]), Buffer.from(bytes)]))
  for (const answer of answers) answer.writeUInt32BE(options.ttl ?? 60, 6)
  const header = Buffer.from([query[0] ?? 0, query[1] ?? 0, 0x81, 0x80 | (options.rcode ?? 0), 0, 1, 0, answers.length, 0, 0, 0, 0])
  return { host: from, port: 53, data: new Uint8Array(Buffer.concat([header, question, ...answers])) }
}

describe('the tunnel resolver', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('asks the primary resolver through the tunnel and answers with the address', async () => {
    const udp = fakeChannel()
    const resolver = createResolver({ bind: async () => udp.channel })
    const found = resolver.resolve('Example.com')
    await vi.advanceTimersByTimeAsync(10)
    expect(udp.sent).toHaveLength(1)
    expect(udp.sent[0]).toMatchObject({ host: '8.8.8.8', port: 53 })
    expect(nameOf(udp.sent[0]?.bytes as Buffer)).toBe('example.com')
    udp.deliver(respond(udp.sent[0]?.bytes as Buffer, '8.8.8.8', [[93, 184, 216, 34]]))
    expect(await found).toBe('93.184.216.34')
    resolver.close()
  })

  it('has every new name asked at once, not one after another', async () => {
    const udp = fakeChannel()
    const resolver = createResolver({ bind: async () => udp.channel })
    const names = ['a.example', 'b.example', 'c.example', 'd.example']
    const found = names.map(async (name) => await resolver.resolve(name))
    await vi.advanceTimersByTimeAsync(10)
    expect(udp.sent.map((entry) => nameOf(entry.bytes))).toEqual(names)
    udp.sent.forEach((entry, index) => { udp.deliver(respond(entry.bytes, '8.8.8.8', [[10, 0, 0, index + 1]])) })
    expect(await Promise.all(found)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'])
    resolver.close()
  })

  it('asks the other resolver after a quiet spell, and a lost datagram does not hold up the next name', async () => {
    const udp = fakeChannel()
    const resolver = createResolver({ bind: async () => udp.channel, attemptMs: 3_000, totalMs: 12_000 })
    const slow = resolver.resolve('lost.example')
    await vi.advanceTimersByTimeAsync(10)
    const other = resolver.resolve('fine.example')
    await vi.advanceTimersByTimeAsync(10)
    udp.deliver(respond(udp.sent[1]?.bytes as Buffer, '8.8.8.8', [[10, 1, 1, 1]]))
    expect(await other).toBe('10.1.1.1')
    await vi.advanceTimersByTimeAsync(3_000)
    const retry = udp.sent.find((entry) => entry.host === '1.1.1.1' && nameOf(entry.bytes) === 'lost.example')
    expect(retry).toBeDefined()
    udp.deliver(respond(retry?.bytes as Buffer, '1.1.1.1', [[10, 2, 2, 2]]))
    expect(await slow).toBe('10.2.2.2')
    resolver.close()
  })

  it('gives up on a name nobody answers for, within its own bound', async () => {
    const udp = fakeChannel()
    const resolver = createResolver({ bind: async () => udp.channel, totalMs: 12_000 })
    const failed = resolver.resolve('void.example').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(12_000)
    const error = await failed
    expect(error).toBeInstanceOf(DnsError)
    expect((error as DnsError).kind).toBe('timeout')
    resolver.close()
  })

  it('says at once that a name does not exist', async () => {
    const udp = fakeChannel()
    const resolver = createResolver({ bind: async () => udp.channel })
    const failed = resolver.resolve('nothing.example').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10)
    udp.deliver(respond(udp.sent[0]?.bytes as Buffer, '8.8.8.8', [], { rcode: 3 }))
    const error = await failed
    expect((error as DnsError).kind).toBe('no-such-name')
    resolver.close()
  })

  it('says at once that the name is at fault when both resolvers fail for it, and not that the tunnel is silent', async () => {
    const udp = fakeChannel()
    const resolver = createResolver({ bind: async () => udp.channel, attemptMs: 3_000 })
    const failed = resolver.resolve('broken.example').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10)
    udp.deliver(respond(udp.sent[0]?.bytes as Buffer, '8.8.8.8', [], { rcode: 2 }))
    await vi.advanceTimersByTimeAsync(3_000)
    const second = udp.sent.find((entry) => entry.host === '1.1.1.1')
    udp.deliver(respond(second?.bytes as Buffer, '1.1.1.1', [], { rcode: 5 }))
    expect((await failed as DnsError).kind).toBe('failed')
    resolver.close()
  })

  it('calls a name that one resolver failed for and the other never answered a failure too, not a silence', async () => {
    const udp = fakeChannel()
    const resolver = createResolver({ bind: async () => udp.channel, totalMs: 12_000 })
    const failed = resolver.resolve('half.example').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10)
    udp.deliver(respond(udp.sent[0]?.bytes as Buffer, '8.8.8.8', [], { rcode: 2 }))
    await vi.advanceTimersByTimeAsync(12_000)
    expect((await failed as DnsError).kind).toBe('failed')
    resolver.close()
  })

  it('looks a name with a trailing dot up as the name without it', async () => {
    const udp = fakeChannel()
    const resolver = createResolver({ bind: async () => udp.channel })
    const found = resolver.resolve('dotted.example.')
    await vi.advanceTimersByTimeAsync(10)
    expect(nameOf(udp.sent[0]?.bytes as Buffer)).toBe('dotted.example')
    udp.deliver(respond(udp.sent[0]?.bytes as Buffer, '8.8.8.8', [[10, 4, 4, 4]]))
    expect(await found).toBe('10.4.4.4')
    resolver.close()
  })

  it('does not take a truncated response, or one that answers another type, for the answer', async () => {
    const udp = fakeChannel()
    const resolver = createResolver({ bind: async () => udp.channel, totalMs: 5_000 })
    const failed = resolver.resolve('picky.example').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10)
    const query = udp.sent[0]?.bytes as Buffer
    const truncated = respond(query, '8.8.8.8', [[6, 6, 6, 6]])
    Buffer.from(truncated.data.buffer, truncated.data.byteOffset, truncated.data.length)[2] = 0x83
    udp.deliver(truncated)
    const other = respond(query, '8.8.8.8', [[6, 6, 6, 6]])
    const otherBytes = Buffer.from(other.data.buffer, other.data.byteOffset, other.data.length)
    otherBytes[otherBytes.indexOf(Buffer.from([0, 0, 1, 0, 1])) + 2] = 28
    udp.deliver(other)
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await failed as DnsError).kind).toBe('timeout')
    resolver.close()
  })

  it('asks for an IPv6 address when a name has no IPv4 one', async () => {
    const udp = fakeChannel()
    const resolver = createResolver({ bind: async () => udp.channel })
    const found = resolver.resolve('six.example')
    await vi.advanceTimersByTimeAsync(10)
    udp.deliver(respond(udp.sent[0]?.bytes as Buffer, '8.8.8.8', []))
    await vi.advanceTimersByTimeAsync(10)
    expect(udp.sent).toHaveLength(2)
    udp.deliver(respond(udp.sent[1]?.bytes as Buffer, '8.8.8.8', [[0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]]))
    expect(await found).toBe('2001:db8:0:0:0:0:0:1')
    resolver.close()
  })

  it('ignores a datagram that is not from a resolver it asked, or answers another name', async () => {
    const udp = fakeChannel()
    const resolver = createResolver({ bind: async () => udp.channel })
    const found = resolver.resolve('real.example')
    await vi.advanceTimersByTimeAsync(10)
    const query = udp.sent[0]?.bytes as Buffer
    udp.deliver(respond(query, '203.0.113.9', [[6, 6, 6, 6]]))
    const wrongName = Buffer.from(query)
    wrongName.write('x', 13)
    udp.deliver(respond(wrongName, '8.8.8.8', [[6, 6, 6, 6]]))
    await vi.advanceTimersByTimeAsync(10)
    udp.deliver(respond(query, '8.8.8.8', [[7, 7, 7, 7]]))
    expect(await found).toBe('7.7.7.7')
    resolver.close()
  })

  it('keeps an answer for its lifetime, and asks again after it', async () => {
    const udp = fakeChannel()
    let clock = 1_000_000
    const resolver = createResolver({ bind: async () => udp.channel, now: () => clock })
    const first = resolver.resolve('cached.example')
    await vi.advanceTimersByTimeAsync(10)
    udp.deliver(respond(udp.sent[0]?.bytes as Buffer, '8.8.8.8', [[10, 9, 9, 9]], { ttl: 100 }))
    expect(await first).toBe('10.9.9.9')
    expect(await resolver.resolve('CACHED.example')).toBe('10.9.9.9')
    expect(udp.sent).toHaveLength(1)
    clock += 101_000
    const again = resolver.resolve('cached.example')
    await vi.advanceTimersByTimeAsync(10)
    expect(udp.sent).toHaveLength(2)
    udp.deliver(respond(udp.sent[1]?.bytes as Buffer, '8.8.8.8', [[10, 9, 9, 10]]))
    expect(await again).toBe('10.9.9.10')
    resolver.close()
  })

  it('shares one question between callers asking for the same name at once', async () => {
    const udp = fakeChannel()
    const resolver = createResolver({ bind: async () => udp.channel })
    const both = [resolver.resolve('same.example'), resolver.resolve('same.example')]
    await vi.advanceTimersByTimeAsync(10)
    expect(udp.sent).toHaveLength(1)
    udp.deliver(respond(udp.sent[0]?.bytes as Buffer, '8.8.8.8', [[10, 3, 3, 3]]))
    expect(await Promise.all(both)).toEqual(['10.3.3.3', '10.3.3.3'])
    resolver.close()
  })

  it('returns an address as it is, without asking', async () => {
    const udp = fakeChannel()
    const resolver = createResolver({ bind: async () => udp.channel })
    expect(await resolver.resolve('203.0.113.5')).toBe('203.0.113.5')
    expect(await resolver.resolve('2001:db8::1')).toBe('2001:db8::1')
    expect(udp.sent).toHaveLength(0)
    resolver.close()
  })

  it('refuses a name that is not one, and closes its socket with the tunnel', async () => {
    const udp = fakeChannel()
    const resolver = createResolver({ bind: async () => udp.channel })
    const long = `${'a'.repeat(64)}.example`
    await expect(resolver.resolve(long)).rejects.toMatchObject({ kind: 'invalid' })
    await expect(resolver.resolve('a..example')).rejects.toMatchObject({ kind: 'invalid' })
    resolver.close()
    await vi.advanceTimersByTimeAsync(10)
    expect(udp.isClosed()).toBe(true)
    await expect(resolver.resolve('late.example')).rejects.toMatchObject({ kind: 'closed' })
  })
})

describe('parseResponse', () => {
  it('reads nothing from bytes that are not a response', () => {
    expect(parseResponse(Buffer.from([1, 2, 3]), 1)).toBeUndefined()
    expect(parseResponse(Buffer.alloc(40), 1)).toBeUndefined()
  })
})
