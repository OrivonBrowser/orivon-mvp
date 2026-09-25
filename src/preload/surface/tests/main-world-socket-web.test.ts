import { describe, expect, it } from 'vitest'
import { installOrivon } from '../main-world-socket.js'
import type { MainWorldWebContextBridge } from '../main-world-socket.js'
import { LIMITS, fakeBridge, fakeSocketBridgeResult, fakeWebContextBridgeResult } from './main-world-socket.test-helpers.js'

// web.openContext's own installOrivon wiring (ADR-0019), split into its own
// sibling file rather than grown onto ./main-world-socket.test.ts (540/800
// lines already) -- the same reason ./main-world-socket-udp.test.ts and
// ./main-world-socket-listen.test.ts exist as siblings of that file instead
// of growing it further.

interface OrivonWebSurface {
  web: {
    openContext: (origin: string, options?: { width?: number, height?: number }) => Promise<{
      id: string
      origin: string
      closed: Promise<void>
      evaluate: (script: string, options?: { timeoutMs?: number }) => Promise<unknown>
      close: () => Promise<void>
    }>
  }
}

function install (bridge: ReturnType<typeof fakeBridge>): OrivonWebSurface {
  const target: Record<string, unknown> = {}
  installOrivon(bridge, LIMITS, target)
  return (target.orivon as { web: OrivonWebSurface['web'] }) as unknown as OrivonWebSurface
}

describe('installOrivon -- web.openContext', () => {
  it('is present on window.orivon', () => {
    const orivon = install(fakeBridge(fakeSocketBridgeResult()))
    expect(typeof orivon.web.openContext).toBe('function')
  })

  it('delegates to bridge.webOpenContext with opts intact, and resolves id/origin unchanged', async () => {
    const bridge = fakeBridge(fakeSocketBridgeResult())
    const calls: unknown[] = []
    bridge.webOpenContext = async (opts) => {
      calls.push(opts)
      return fakeWebContextBridgeResult({ id: 'ctx-9', origin: 'https://example.com' })
    }
    const orivon = install(bridge)

    const context = await orivon.web.openContext('https://example.com', { width: 800, height: 600 })

    expect(calls).toEqual([{ origin: 'https://example.com', width: 800, height: 600 }])
    expect(context.id).toBe('ctx-9')
    expect(context.origin).toBe('https://example.com')
  })

  it('evaluate delegates to the nested bridge closure with the script, returning its result', async () => {
    const bridge = fakeBridge(fakeSocketBridgeResult())
    const calls: string[] = []
    bridge.webOpenContext = async () => fakeWebContextBridgeResult({
      evaluate: async (script) => { calls.push(script); return 'https://example.com' }
    })
    const orivon = install(bridge)

    const context = await orivon.web.openContext('https://example.com')
    const result = await context.evaluate('location.origin')

    expect(calls).toEqual(['location.origin'])
    expect(result).toBe('https://example.com')
  })

  it('evaluate hands a per-call timeoutMs through to the bridge, which the broker enforces', async () => {
    const bridge = fakeBridge(fakeSocketBridgeResult())
    const calls: unknown[] = []
    bridge.webOpenContext = async () => fakeWebContextBridgeResult({
      evaluate: async (script, options) => { calls.push([script, options]); return 1 }
    })
    const orivon = install(bridge)

    const context = await orivon.web.openContext('https://example.com')
    await context.evaluate('1', { timeoutMs: 2_000 })

    expect(calls).toEqual([['1', { timeoutMs: 2_000 }]])
  })

  it('close delegates to the nested bridge closure', async () => {
    const bridge = fakeBridge(fakeSocketBridgeResult())
    let closed = false
    bridge.webOpenContext = async () => fakeWebContextBridgeResult({ close: async () => { closed = true } })
    const orivon = install(bridge)

    const context = await orivon.web.openContext('https://example.com')
    await context.close()

    expect(closed).toBe(true)
  })

  it('closed is the SAME live promise the bridge result carries, not a fresh never-settling one', async () => {
    const bridge = fakeBridge(fakeSocketBridgeResult())
    let resolveClosed: (() => void) | undefined
    const closedSource = new Promise<void>((resolve) => { resolveClosed = resolve })
    bridge.webOpenContext = async () => fakeWebContextBridgeResult({ closed: closedSource })
    const orivon = install(bridge)

    const context = await orivon.web.openContext('https://example.com')
    let settled = false
    void context.closed.then(() => { settled = true })
    expect(settled).toBe(false)

    resolveClosed?.()
    await context.closed
    expect(settled).toBe(true)
  })

  // A152, this capability's own instance of the fix main-world-socket.test.ts
  // already proves for net.connect: a rejection crossing contextBridge's own
  // promise marshalling loses `instanceof Error`, and installOrivon revives
  // it before the page ever sees it.
  it('A152: revives a plain-object rejection from evaluate into a real Error', async () => {
    const bridge = fakeBridge(fakeSocketBridgeResult())
    bridge.webOpenContext = async () => fakeWebContextBridgeResult({
      evaluate: async () => { throw { name: 'OrivonError', message: 'evaluate exceeded its budget', code: 'timeout' } }
    })
    const orivon = install(bridge)

    const context = await orivon.web.openContext('https://example.com')
    let caught: unknown
    try {
      await context.evaluate('slow()')
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('timeout')
  })

  it('A152: revives a plain-object rejection from the closed promise into a real Error', async () => {
    const bridge = fakeBridge(fakeSocketBridgeResult())
    const closedSource: Promise<void> = Promise.reject(
      { name: 'OrivonError', message: 'the grant authorising this context was withdrawn', code: 'revoked' }
    )
    closedSource.catch(() => {})
    bridge.webOpenContext = async () => fakeWebContextBridgeResult({ closed: closedSource })
    const orivon = install(bridge)

    const context = await orivon.web.openContext('https://example.com')
    let caught: unknown
    try {
      await context.closed
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('revoked')
  })

  it('resolves an object whose fields cannot be reassigned (Object.freeze)', async () => {
    const orivon = install(fakeBridge(fakeSocketBridgeResult()))
    const context = await orivon.web.openContext('https://example.com') as unknown as MainWorldWebContextBridge
    expect(Object.isFrozen(context)).toBe(true)
  })
})
