// installChildrenBridge's page-caller check (ADR-0045 applied to ADR-0046's bridge): real V8
// frames built with node:vm, and the real internal-net slot from installOrivon, so a drift in
// either side's attribution shows here.
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { installChildrenBridge } from '../expose-child-host-connect.js'
import type { ChildrenPageBridge } from '../expose-child-host-connect.js'
import { installOrivon } from '../surface/main-world-socket.js'
import { LIMITS, fakeBridge, fakeSocketBridgeResult } from '../surface/tests/main-world-socket.test-helpers.js'

function frameNamed (filename: string): <T>(fn: () => T) => T {
  return new vm.Script('(fn) => fn()', { filename }).runInThisContext() as <T>(fn: () => T) => T
}
const asPageFrame = frameNamed('https://orivon-test.example/app.js')
const asExtensionFrame = frameNamed('chrome-extension://abcdefghijklmnopabcdefghijklmnop/content.js')

const SLOT = Symbol.for('orivon.internal-net')
const CHILDREN = Symbol.for('orivon:children')

function fakeChildrenBridge (): ChildrenPageBridge & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    start: async () => { calls.push('start'); return '0' },
    send: () => { calls.push('send') },
    kill: () => { calls.push('kill') }
  }
}

function installedOn (target: Record<PropertyKey, unknown>, bridge: ChildrenPageBridge): ChildrenPageBridge {
  installChildrenBridge(bridge, target)
  return target[CHILDREN] as ChildrenPageBridge
}

function targetWithRealSlot (): Record<PropertyKey, unknown> {
  const target: Record<PropertyKey, unknown> = {}
  installOrivon(fakeBridge(fakeSocketBridgeResult()), LIMITS, target as { orivon?: unknown })
  return target
}

const DENIED = { name: 'OrivonError', code: 'denied' }

describe('installChildrenBridge: the page-caller check', () => {
  it('a page-frame caller reaches start, send and kill', async () => {
    const inner = fakeChildrenBridge()
    const bridge = installedOn(targetWithRealSlot(), inner)
    await expect(asPageFrame(async () => await bridge.start({}, () => {}))).resolves.toBe('0')
    asPageFrame(() => { bridge.send('0', {}) })
    asPageFrame(() => { bridge.kill('0') })
    expect(inner.calls).toEqual(['start', 'send', 'kill'])
  })

  it('a caller with no page frame is refused: start rejects, send and kill throw, nothing reaches the bridge', async () => {
    const inner = fakeChildrenBridge()
    const bridge = installedOn(targetWithRealSlot(), inner)
    await expect(bridge.start({}, () => {})).rejects.toMatchObject(DENIED)
    expect(() => { bridge.send('0', {}) }).toThrow(expect.objectContaining(DENIED))
    expect(() => { bridge.kill('0') }).toThrow(expect.objectContaining(DENIED))
    expect(inner.calls).toEqual([])
  })

  it('an extension-frame caller is refused', async () => {
    const inner = fakeChildrenBridge()
    const bridge = installedOn(targetWithRealSlot(), inner)
    await expect(asExtensionFrame(async () => await bridge.start({}, () => {}))).rejects.toMatchObject(DENIED)
    expect(() => { asExtensionFrame(() => { bridge.kill('0') }) }).toThrow(expect.objectContaining(DENIED))
    expect(inner.calls).toEqual([])
  })

  it('a page frame that calls from a promise continuation and a timer callback still passes', async () => {
    const inner = fakeChildrenBridge()
    const bridge = installedOn(targetWithRealSlot(), inner)
    // Both continuations are defined by page-script code, as the shim's bundle defines its own.
    const viaPromise = new vm.Script('(b) => Promise.resolve().then(() => { b.send("0", {}) })', { filename: 'https://orivon-test.example/app.js' }).runInThisContext() as (b: ChildrenPageBridge) => Promise<void>
    await viaPromise(bridge)
    const viaTimer = new vm.Script('(b) => new Promise((resolve) => { setTimeout(() => { b.send("0", {}); resolve() }, 0) })', { filename: 'https://orivon-test.example/app.js' }).runInThisContext() as (b: ChildrenPageBridge) => Promise<void>
    await viaTimer(bridge)
    expect(inner.calls).toEqual(['send', 'send'])
  })

  it('a missing slot refuses every entry', async () => {
    const inner = fakeChildrenBridge()
    const bridge = installedOn({}, inner)
    await expect(asPageFrame(async () => await bridge.start({}, () => {}))).rejects.toMatchObject(DENIED)
    expect(() => { asPageFrame(() => { bridge.send('0', {}) }) }).toThrow(expect.objectContaining(DENIED))
    expect(() => { asPageFrame(() => { bridge.kill('0') }) }).toThrow(expect.objectContaining(DENIED))
    expect(inner.calls).toEqual([])
  })

  it('a slot without callerIsPage refuses every entry', async () => {
    const inner = fakeChildrenBridge()
    const bridge = installedOn({ [SLOT]: { connect: vi.fn() } }, inner)
    await expect(asPageFrame(async () => await bridge.start({}, () => {}))).rejects.toMatchObject(DENIED)
    expect(inner.calls).toEqual([])
  })

  it('the refusal is a real Error carrying the denied code, like guarded\'s', async () => {
    const bridge = installedOn({}, fakeChildrenBridge())
    const error = await bridge.start({}, () => {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
  })
})
