// An app abandoning a dial (ConnectOptions.signal, ADR-0071): the call rejects 'closed' at once, the dial is told to stop,
// and the origin's in-flight slot is free before the dial itself has noticed.

import { describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../contracts/index.js'
import { rejection } from '../handles/tests/handles.test-helpers.js'
import { fail } from '../errors.js'
import { createBroker } from '../index.js'
import { APP, baseDeps, brokerWithConnectGrant, manifestWith, brokerWithConnectSecureGrant, okSecureSocket, okSocket } from './index.test-helpers.js'
import type { Dial, DialSecure } from '../broker-contracts.js'

const TARGET = { host: '93.184.216.34', port: 443 }
const SECURE_TARGET = { host: 'api.example.com', port: 443 }

/** Lets pending microtasks and one macrotask run, so a started dial has reached the dial dependency. */
function settle (): Promise<void> { return new Promise((resolve) => { setTimeout(resolve, 0) }) }

/** A dial that never answers until its signal aborts, as the real one behaves. */
function hungDial (): { dial: Dial, signals: AbortSignal[] } {
  const signals: AbortSignal[] = []
  const dial: Dial = async (_addresses, _port, signal) => await new Promise((_resolve, reject) => {
    signals.push(signal)
    signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
  })
  return { dial, signals }
}

describe('an aborted signal abandons net.connect', () => {
  it('rejects closed and aborts the dial it started', async () => {
    const { dial, signals } = hungDial()
    const broker = await brokerWithConnectGrant({ dial })
    const controller = new AbortController()
    const pending = rejection(broker.net.connect(APP, { ...TARGET, signal: controller.signal }))
    await settle()

    controller.abort()

    expect((await pending).code).toBe('closed')
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
  })

  it('rejects closed without dialling when the signal is already aborted', async () => {
    const dial = vi.fn<Dial>(async () => okSocket())
    const broker = await brokerWithConnectGrant({ dial })

    const error = await rejection(broker.net.connect(APP, { ...TARGET, signal: AbortSignal.abort() }))

    expect(error.code).toBe('closed')
    expect(dial).not.toHaveBeenCalled()
  })

  it('frees the in-flight slot at once, even for a dial that never notices the abort', async () => {
    const started: number[] = []
    const dial: Dial = async () => {
      started.push(started.length)
      return await new Promise(() => {})
    }
    const broker = await brokerWithConnectGrant({ dial })
    const controllers = Array.from({ length: LIMITS.inFlightOperations }, () => new AbortController())
    const calls = controllers.map(async (controller) => await rejection(broker.net.connect(APP, { ...TARGET, signal: controller.signal })))
    await settle()
    expect(started).toHaveLength(LIMITS.inFlightOperations)

    const waiting = broker.net.connect(APP, TARGET)
    waiting.catch(() => {})
    await settle()
    expect(started).toHaveLength(LIMITS.inFlightOperations)

    controllers[0]?.abort()
    await calls[0]
    await settle()

    expect(started).toHaveLength(LIMITS.inFlightOperations + 1)
  })

  it('leaves the queue for a slot without ever dialling', async () => {
    const started: number[] = []
    const dial: Dial = async () => { started.push(started.length); return await new Promise(() => {}) }
    const broker = await brokerWithConnectGrant({ dial })
    for (let i = 0; i < LIMITS.inFlightOperations; i++) broker.net.connect(APP, TARGET).catch(() => {})
    await settle()
    const controller = new AbortController()
    const queued = rejection(broker.net.connect(APP, { ...TARGET, signal: controller.signal }))
    await settle()

    controller.abort()

    expect((await queued).code).toBe('closed')
    expect(started).toHaveLength(LIMITS.inFlightOperations)
  })

  it('destroys a socket the dial returned in the same turn as the abort, and registers no handle', async () => {
    const destroy = vi.fn()
    let finish!: () => void
    const dial: Dial = async () => {
      await new Promise<void>((resolve) => { finish = resolve })
      return okSocket({ destroy })
    }
    const broker = await brokerWithConnectGrant({ dial })
    const controller = new AbortController()
    const pending = rejection(broker.net.connect(APP, { ...TARGET, signal: controller.signal }))
    await settle()

    controller.abort()
    finish()

    expect((await pending).code).toBe('closed')
    await settle()
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('does nothing once the socket was returned', async () => {
    const destroy = vi.fn()
    const broker = await brokerWithConnectGrant({ dial: async () => okSocket({ destroy }) })
    const controller = new AbortController()
    const socket = await broker.net.connect(APP, { ...TARGET, signal: controller.signal })

    controller.abort()
    await settle()

    expect(destroy).not.toHaveBeenCalled()
    await socket.close()
  })

  it('keeps the timeout answer when the dial timed out before the abort', async () => {
    const broker = await brokerWithConnectGrant({ dial: async () => { throw fail('timeout', 'connecting exceeded its budget') } })
    const controller = new AbortController()
    const error = await rejection(broker.net.connect(APP, { ...TARGET, signal: controller.signal }))

    controller.abort()

    expect(error.code).toBe('timeout')
  })

  it('still answers a withdrawn grant with revoked', async () => {
    const { dial } = hungDial()
    const broker = createBroker(baseDeps({ dial }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
    const grant = await broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])
    const controller = new AbortController()
    const pending = rejection(broker.net.connect(APP, { ...TARGET, signal: controller.signal }))
    await settle()

    await broker.revoke(APP, grant.id)

    expect((await pending).code).toBe('revoked')
    controller.abort()
  })
})

describe('an aborted signal abandons net.connectSecure', () => {
  it('rejects closed, aborts the handshake and frees the slot', async () => {
    const signals: AbortSignal[] = []
    const dialSecure: DialSecure = async (_target, _options, signal) => await new Promise((_resolve, reject) => {
      signals.push(signal)
      signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
    const broker = await brokerWithConnectSecureGrant({ dialSecure })
    const controller = new AbortController()
    const pending = rejection(broker.net.connectSecure(APP, { ...SECURE_TARGET, signal: controller.signal }))
    await settle()

    controller.abort()

    expect((await pending).code).toBe('closed')
    expect(signals[0]?.aborted).toBe(true)
  })

  it('rejects closed without a handshake when the signal is already aborted', async () => {
    const dialSecure = vi.fn<DialSecure>(async () => okSecureSocket())
    const broker = await brokerWithConnectSecureGrant({ dialSecure })

    const error = await rejection(broker.net.connectSecure(APP, { ...SECURE_TARGET, signal: AbortSignal.abort() }))

    expect(error.code).toBe('closed')
    expect(dialSecure).not.toHaveBeenCalled()
  })

  it('passes the dial no signal option of its own', async () => {
    const dialSecure = vi.fn<DialSecure>(async () => okSecureSocket())
    const broker = await brokerWithConnectSecureGrant({ dialSecure })

    await broker.net.connectSecure(APP, { ...SECURE_TARGET, signal: new AbortController().signal })

    expect(dialSecure.mock.calls[0]?.[1]).not.toHaveProperty('signal')
  })
})

