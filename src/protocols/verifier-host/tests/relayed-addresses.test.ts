// How the host looks a name up for the check of a CCIP-Read gateway: main's answer while the name relay runs, the host's own
// lookup while it does not, and a failed check, never an own lookup, when main refuses or does not answer.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { guardedCcipRequest } from '../egress.js'
import type { AddressAnswer, FromHost } from '../protocol.js'
import { MAX_ANSWERED_ADDRESSES } from '../protocol.js'
import { ANSWER_TIMEOUT_MS, createRelayedAddresses, MAX_PENDING } from '../relayed-addresses.js'

afterEach(() => { vi.useRealTimers() })

function rig (options: { timeoutMs?: number } = {}) {
  const posted: FromHost[] = []
  const own = vi.fn(async (_host: string): Promise<readonly string[]> => ['93.184.216.34'])
  const relayed = createRelayedAddresses({ post: (message) => { posted.push(message) }, own, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) })
  const asks = (): Array<{ id: number, host: string }> => posted.flatMap((message) => message.type === 'address-lookup' ? [{ id: message.id, host: message.host }] : [])
  return { relayed, own, asks }
}

type Body = AddressAnswer extends infer Each ? (Each extends AddressAnswer ? Omit<Each, 'type' | 'id'> : never) : never
const answer = (id: number, rest: Body): AddressAnswer => ({ type: 'address-answer', id, ...rest } as AddressAnswer)

describe('a name the check asks about', () => {
  it('is the addresses main answers with while the relay runs, and the host looks nothing up', async () => {
    const { relayed, own, asks } = rig()
    const pending = relayed.resolve('gateway.example')
    expect(asks()).toEqual([{ id: 1, host: 'gateway.example' }])
    relayed.receive(answer(1, { kind: 'addresses', addresses: ['93.184.216.40', '2606:2800::1'] }))
    expect(await pending).toEqual(['93.184.216.40', '2606:2800::1'])
    expect(own).not.toHaveBeenCalled()
  })

  it('is the host\'s own lookup while no relay runs', async () => {
    const { relayed, own } = rig()
    const pending = relayed.resolve('gateway.example')
    relayed.receive(answer(1, { kind: 'none' }))
    expect(await pending).toEqual(['93.184.216.34'])
    expect(own).toHaveBeenCalledExactlyOnceWith('gateway.example')
  })

  it('fails the check when main could not look it up, and the host looks nothing up', async () => {
    const { relayed, own } = rig()
    const pending = relayed.resolve('gateway.example')
    relayed.receive(answer(1, { kind: 'refused' }))
    await expect(pending).rejects.toThrow('could not look this name up')
    expect(own).not.toHaveBeenCalled()
  })

  it('fails the check on an answer with no address or with more than the host accepts', async () => {
    const { relayed } = rig()
    const empty = relayed.resolve('a.example')
    relayed.receive(answer(1, { kind: 'addresses', addresses: [] }))
    await expect(empty).rejects.toThrow()
    const many = relayed.resolve('b.example')
    relayed.receive(answer(2, { kind: 'addresses', addresses: Array.from({ length: MAX_ANSWERED_ADDRESSES + 1 }, (_, index) => `93.184.216.${String(index)}`) }))
    await expect(many).rejects.toThrow()
  })

  it('fails the check, and looks nothing up, when main does not answer in time', async () => {
    vi.useFakeTimers()
    const { relayed, own } = rig()
    const pending = relayed.resolve('gateway.example')
    const caught = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS)
    expect(await caught).toBeInstanceOf(Error)
    expect(own).not.toHaveBeenCalled()
    expect(ANSWER_TIMEOUT_MS).toBe(20_000)
  })

  it('numbers each question, answers each by its number, and drops an answer that is late, repeated or was never asked for', async () => {
    const { relayed, asks } = rig()
    const first = relayed.resolve('a.example')
    const second = relayed.resolve('b.example')
    expect(asks().map((ask) => ask.id)).toEqual([1, 2])
    relayed.receive(answer(2, { kind: 'addresses', addresses: ['93.184.216.2'] }))
    relayed.receive(answer(2, { kind: 'addresses', addresses: ['10.0.0.1'] }))
    relayed.receive(answer(9, { kind: 'addresses', addresses: ['10.0.0.2'] }))
    relayed.receive(answer(1, { kind: 'addresses', addresses: ['93.184.216.1'] }))
    expect(await second).toEqual(['93.184.216.2'])
    expect(await first).toEqual(['93.184.216.1'])
  })

  it('refuses a question when too many are waiting', async () => {
    const { relayed, asks } = rig()
    const waiting = Array.from({ length: MAX_PENDING }, async (_, index) => await relayed.resolve(`n${String(index)}.example`).catch(() => undefined))
    expect(asks()).toHaveLength(MAX_PENDING)
    await expect(relayed.resolve('one-more.example')).rejects.toThrow('too many')
    for (const ask of asks()) relayed.receive(answer(ask.id, { kind: 'none' }))
    await Promise.all(waiting)
  })
})

describe('the check of a CCIP-Read gateway, over main\'s answers', () => {
  const parameters = { sender: '0xABCDEF0000000000000000000000000000000001', data: '0x1234', urls: ['https://gateway.example/{sender}/{data}.json'] } as unknown as Parameters<typeof guardedCcipRequest>[0]
  const reply = (): Response => new Response(JSON.stringify({ data: '0xabcd' }), { headers: { 'content-type': 'application/json' } })

  async function check (main: (ask: { id: number, host: string }) => AddressAnswer | undefined) {
    const fetched: string[] = []
    const relayed = createRelayedAddresses({ post: (message) => { if (message.type === 'address-lookup') { const given = main(message); if (given !== undefined) queueMicrotask(() => { relayed.receive(given) }) } }, own: async () => ['93.184.216.34'] })
    const outcome = await guardedCcipRequest(parameters, {
      directFetch: async () => { throw new Error('no direct fetch') },
      fetch: async (url) => { fetched.push(url); return reply() },
      resolveHost: relayed.resolve,
      direct: false
    }).then((value) => ({ value }), (error: unknown) => ({ error: error as Error }))
    return { outcome, fetched }
  }

  it('reads a gateway whose addresses the relay found are public', async () => {
    const { outcome, fetched } = await check((ask) => answer(ask.id, { kind: 'addresses', addresses: ['93.184.216.40'] }))
    expect(outcome).toEqual({ value: '0xabcd' })
    expect(fetched).toHaveLength(1)
  })

  it('reads nothing when any address the relay found is not public, whatever the host\'s own lookup would say', async () => {
    const { outcome, fetched } = await check((ask) => answer(ask.id, { kind: 'addresses', addresses: ['93.184.216.40', '192.168.1.5'] }))
    expect('error' in outcome && outcome.error.message).toContain('192.168.1.5')
    expect(fetched).toEqual([])
  })

  it('reads nothing when the relay could not look the name up', async () => {
    const { outcome, fetched } = await check((ask) => answer(ask.id, { kind: 'refused' }))
    expect('error' in outcome).toBe(true)
    expect(fetched).toEqual([])
  })

  it('keeps the host\'s own lookup while no relay runs', async () => {
    const { outcome, fetched } = await check((ask) => answer(ask.id, { kind: 'none' }))
    expect(outcome).toEqual({ value: '0xabcd' })
    expect(fetched).toHaveLength(1)
  })
})
