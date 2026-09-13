import { describe, expect, it, vi } from 'vitest'

// manifest-hint.ts imports ipcMain from 'electron' at module scope for its
// subsystem wiring -- mocked first, same reasoning as
// request-grant-subsystem.test.ts's own header.
vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))

const { manifestHintSubsystem } = await import('../manifest-hint.js')
const { createSubsystemContext, publishBroker, publishLoader } = await import('../registry.js')
const { stubBroker } = await import('../../broker/transport/tests/ipc.test-helpers.js')

import type { App } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import type { Loader } from '../../loader/index.js'

const fakeApp = {} as unknown as App
const fakeLoaderInstance: Loader = { load: async () => ({ outcome: 'rejected', reason: 'unused' }) }

describe('manifestHintSubsystem', () => {
  it('throws when ctx.broker is undefined -- must be listed after brokerIpcSubsystem', () => {
    const ctx = createSubsystemContext(fakeApp)
    expect(() => manifestHintSubsystem.afterReady?.(ctx)).toThrow(/ctx\.broker/)
  })

  // src/loader/README.md and this lane's own brief: loaderSubsystem is NOT
  // critical, so ctx.loader may legitimately be undefined -- that means
  // "the discovery trigger is disabled this run", never a thrown error.
  it('does not throw, and registers nothing, when ctx.loader is undefined', async () => {
    const ctx = createSubsystemContext(fakeApp)
    publishBroker(ctx, stubBroker([]) as unknown as Broker)
    const { ipcMain } = await import('electron') as unknown as { ipcMain: { on: ReturnType<typeof vi.fn> } }
    ipcMain.on.mockClear()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await manifestHintSubsystem.afterReady?.(ctx)

    expect(warnSpy).toHaveBeenCalled()
    expect(ipcMain.on).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('registers the ipc listener once both ctx.broker and ctx.loader are present', async () => {
    const ctx = createSubsystemContext(fakeApp)
    publishBroker(ctx, stubBroker([]) as unknown as Broker)
    publishLoader(ctx, fakeLoaderInstance)
    const { ipcMain } = await import('electron') as unknown as { ipcMain: { on: ReturnType<typeof vi.fn> } }
    ipcMain.on.mockClear()

    await manifestHintSubsystem.afterReady?.(ctx)

    expect(ipcMain.on).toHaveBeenCalled()
  })

  it('is not marked critical -- an unwired discovery trigger must never take the real browser down', () => {
    expect(manifestHintSubsystem.critical).not.toBe(true)
  })
})
