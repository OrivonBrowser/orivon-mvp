import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSubsystemContext, publishBroker } from '../registry.js'
import { devGrantSubsystem, installDevGrantHook, shouldInstallDevGrant } from '../dev-grant.js'
import type { Broker } from '../../broker/broker-contracts.js'
import type { App } from 'electron'
import type { CapabilityKind, Grant, Manifest, Pattern } from '../../contracts/index.js'

const fakeApp = {} as unknown as App

const testManifest: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.test',
  name: 'Dev-grant test app',
  version: '0.1.0',
  entry: 'index.html',
  capabilities: {}
}

/** A minimal Broker whose registerApp/grant are spies, everything else refuses to be called. */
function fakeBroker (): { broker: Broker, registerApp: ReturnType<typeof vi.fn>, grant: ReturnType<typeof vi.fn> } {
  const registerApp = vi.fn(async () => {})
  const grantedRecord: Grant = { id: 'g1', origin: 'http://example.test', capability: 'tcp.connect', patterns: ['a:1'], grantedAt: 0 }
  const grant = vi.fn(async () => grantedRecord)
  const unused = (): never => { throw new Error('not exercised by this test') }
  const broker = {
    app: { manifest: unused, grants: unused },
    fs: { readFile: unused, writeFile: unused },
    net: { connect: unused, udpBind: unused, close: unused, setNoDelay: unused, setKeepAlive: unused },
    id: { publicKey: unused, sign: unused },
    registerApp,
    revoke: unused,
    grant
  } as unknown as Broker
  return { broker, registerApp, grant }
}

afterEach(() => {
  globalThis.__orivonDevGrant = undefined
})

describe('shouldInstallDevGrant', () => {
  it('is true only for the literal flag value true', () => {
    expect(shouldInstallDevGrant(true)).toBe(true)
    expect(shouldInstallDevGrant(false)).toBe(false)
    expect(shouldInstallDevGrant(undefined)).toBe(false)
  })
})

describe('installDevGrantHook', () => {
  it('registers the app then grants the requested capability, on the SAME broker passed in', async () => {
    const { broker, registerApp, grant } = fakeBroker()
    installDevGrantHook(broker)

    expect(globalThis.__orivonDevGrant).toBeTypeOf('function')

    const patterns: readonly Pattern[] = ['127.0.0.1:9']
    const capability: CapabilityKind = 'tcp.connect'
    const result = await globalThis.__orivonDevGrant?.({
      origin: 'http://example.test', manifest: testManifest, capability, patterns
    })

    expect(registerApp).toHaveBeenCalledWith('http://example.test', testManifest)
    expect(grant).toHaveBeenCalledWith('http://example.test', capability, patterns)
    expect(result).toEqual({ id: 'g1', origin: 'http://example.test', capability: 'tcp.connect', patterns: ['a:1'], grantedAt: 0 })
  })

  it('registers the app before granting, not the other way round', async () => {
    const order: string[] = []
    const broker = {
      registerApp: vi.fn(async () => { order.push('registerApp') }),
      grant: vi.fn(async () => { order.push('grant'); return {} as Grant })
    } as unknown as Broker
    installDevGrantHook(broker)

    await globalThis.__orivonDevGrant?.({ origin: 'http://x.test', manifest: testManifest, capability: 'id', patterns: [] })

    expect(order).toEqual(['registerApp', 'grant'])
  })
})

describe('devGrantSubsystem', () => {
  it('never installs the hook under a plain vitest run, because the compiled-in flag is absent', async () => {
    const ctx = createSubsystemContext(fakeApp)
    const { broker } = fakeBroker()
    publishBroker(ctx, broker)

    await devGrantSubsystem.afterReady?.(ctx)

    expect(globalThis.__orivonDevGrant).toBeUndefined()
  })

  it('is not marked critical -- a broken dev-only path must never take the real browser down', () => {
    expect(devGrantSubsystem.critical).not.toBe(true)
  })
})
