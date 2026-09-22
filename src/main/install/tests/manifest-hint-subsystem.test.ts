import { describe, expect, it, vi } from 'vitest'

// manifest-hint.ts imports ipcMain from 'electron' at module scope for its
// subsystem wiring -- mocked first, same reasoning as
// request-grant-subsystem.test.ts's own header.
vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))

const { manifestHintSubsystem } = await import('../manifest-hint.js')
const { createSubsystemContext, publishInstallApp } = await import('../../registry.js')

import type { App } from 'electron'
import type { LoadResult } from '../../../loader/index.js'

const fakeApp = {} as unknown as App
const REJECTED: LoadResult = { outcome: 'rejected', reason: 'unused' }

async function ipcOnSpy (): Promise<ReturnType<typeof vi.fn>> {
  const { ipcMain } = await import('electron') as unknown as { ipcMain: { on: ReturnType<typeof vi.fn> } }
  ipcMain.on.mockClear()
  return ipcMain.on
}

describe('manifestHintSubsystem', () => {
  // It reads ONLY ctx.installApp now, not ctx.broker/ctx.loader. That is the
  // point: appInstallSubsystem publishes one install entry point already
  // closing over the real consent prompt, so this subsystem cannot assemble
  // an install path that skips consent (d-0025). See manifest-hint.ts's own
  // doc on createManifestHintListener for the defect that shape prevents.
  it('does not throw, and registers nothing, when ctx.installApp is undefined', async () => {
    const ctx = createSubsystemContext(fakeApp)
    const on = await ipcOnSpy()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await manifestHintSubsystem.afterReady?.(ctx)

    expect(warnSpy).toHaveBeenCalled()
    expect(on).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('registers the ipc listener once ctx.installApp is published', async () => {
    const ctx = createSubsystemContext(fakeApp)
    publishInstallApp(ctx, async () => REJECTED)
    const on = await ipcOnSpy()

    await manifestHintSubsystem.afterReady?.(ctx)

    expect(on).toHaveBeenCalled()
  })

  // The regression this shape exists to prevent: the listener must invoke
  // the PUBLISHED install function -- the one carrying consent -- and not a
  // path of its own. Asserted by driving the registered handler and checking
  // the published function is what ran.
  it('routes a hint through the published install function, not a locally built one', async () => {
    const ctx = createSubsystemContext(fakeApp)
    const installApp = vi.fn(async () => REJECTED)
    publishInstallApp(ctx, installApp)
    const on = await ipcOnSpy()

    await manifestHintSubsystem.afterReady?.(ctx)
    const firstCall = on.mock.calls[0]
    expect(firstCall).toBeDefined()
    const handler = firstCall?.[1] as (event: unknown, hintedUrl: unknown) => void
    handler({ senderFrame: { url: 'https://app.example/page', origin: 'https://app.example' } }, 'https://app.example/manifest.json')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(installApp).toHaveBeenCalledWith('https://app.example', 'https://app.example/manifest.json')
  })

  it('is not marked critical -- an unwired discovery trigger must never take the real browser down', () => {
    expect(manifestHintSubsystem.critical).not.toBe(true)
  })
})
