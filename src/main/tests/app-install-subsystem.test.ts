import { describe, expect, it, vi } from 'vitest'

// app-install-subsystem.ts pulls in install-consent-prompt.ts, which imports
// 'electron' at module scope -- mocked first, same reasoning as
// request-grant-subsystem.test.ts's own header.
vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) } }))

const { appInstallSubsystem } = await import('../app-install-subsystem.js')
const { createSubsystemContext, publishBroker, publishLoader } = await import('../registry.js')
const { stubBroker } = await import('../../broker/transport/tests/ipc.test-helpers.js')

import type { App } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import type { Loader } from '../../loader/index.js'

const fakeApp = {} as unknown as App
const fakeLoader: Loader = { load: async () => ({ outcome: 'rejected', reason: 'unused' }) }

describe('appInstallSubsystem', () => {
  it('throws when ctx.broker is undefined -- must be listed after brokerIpcSubsystem', () => {
    const ctx = createSubsystemContext(fakeApp)
    expect(() => appInstallSubsystem.afterReady?.(ctx)).toThrow(/ctx\.broker/)
  })

  it('throws when ctx.loader is undefined -- must be listed after loaderSubsystem', () => {
    const ctx = createSubsystemContext(fakeApp)
    publishBroker(ctx, stubBroker([]) as unknown as Broker)
    expect(() => appInstallSubsystem.afterReady?.(ctx)).toThrow(/ctx\.loader/)
  })

  it('publishes an installApp function on ctx once both broker and loader are present', async () => {
    const ctx = createSubsystemContext(fakeApp)
    publishBroker(ctx, stubBroker([]) as unknown as Broker)
    publishLoader(ctx, fakeLoader)

    await appInstallSubsystem.afterReady?.(ctx)

    expect(ctx.installApp).toBeTypeOf('function')
  })

  it('is not marked critical -- an unwired install path must never take the real browser down', () => {
    expect(appInstallSubsystem.critical).not.toBe(true)
  })
})
