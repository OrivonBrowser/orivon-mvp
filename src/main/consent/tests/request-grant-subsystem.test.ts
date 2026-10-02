import { describe, expect, it, vi } from 'vitest'

// The grant prompt asks through askQuestion; nothing here opens a question, so
// it is replaced outright, and `electron` is mocked first for the modules
// the subsystem imports around it (same reasoning as tabs.test.ts).
vi.mock('electron', () => ({}))
vi.mock('../../shell/question/ask-question.js', () => ({ askQuestion: vi.fn(async () => ({ response: 1, checkboxChecked: false })) }))

const { requestGrantSubsystem } = await import('../request-grant-subsystem.js')
const { createSubsystemContext, publishBroker } = await import('../../registry.js')
const { stubBroker } = await import('../../../broker/transport/tests/ipc.test-helpers.js')

import type { App } from 'electron'
import type { Broker } from '../../../broker/broker-contracts.js'

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
