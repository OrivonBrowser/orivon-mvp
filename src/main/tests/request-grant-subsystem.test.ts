import { describe, expect, it, vi } from 'vitest'

// request-grant-prompt.ts imports 'electron' at module scope, and
// request-grant-subsystem.ts imports that -- mocked first, same reasoning
// as tabs.test.ts and request-grant-prompt.test.ts's own headers.
vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) } }))

const { requestGrantSubsystem } = await import('../request-grant-subsystem.js')
const { createSubsystemContext, publishBroker } = await import('../registry.js')
const { stubBroker } = await import('../../broker/transport/tests/ipc.test-helpers.js')

import type { App } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'

const fakeApp = {} as unknown as App

describe('requestGrantSubsystem', () => {
  it('throws when ctx.broker is undefined -- must be listed after brokerIpcSubsystem', () => {
    const ctx = createSubsystemContext(fakeApp)
    expect(() => requestGrantSubsystem.afterReady?.(ctx)).toThrow(/ctx\.broker/)
  })

  it('publishes a requestGrant function on ctx once the broker is present', async () => {
    const ctx = createSubsystemContext(fakeApp)
    publishBroker(ctx, stubBroker([]) as unknown as Broker)

    await requestGrantSubsystem.afterReady?.(ctx)

    expect(ctx.requestGrant).toBeTypeOf('function')
  })

  it('is not marked critical -- an unwired consent surface must never take the real browser down', () => {
    expect(requestGrantSubsystem.critical).not.toBe(true)
  })
})
