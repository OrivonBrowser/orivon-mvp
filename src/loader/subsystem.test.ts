import { describe, expect, it } from 'vitest'
import { loaderSubsystem } from './subsystem.js'
import { createSubsystemContext } from '../main/registry.js'
import type { App } from 'electron'

// A fake App, not a real one -- getPath is the only method afterReady
// actually calls, and neither createLoader nor nodeLoaderStorage touches
// Electron or the filesystem eagerly at construction time (only load()/
// writeAsset()/writePin()/readPin() do, none of which this file calls). The
// same reasoning brokerIpcSubsystem's own afterReady relies on for its own
// electron-free unit testability (registry.ts's header).
function fakeApp (): App {
  return { getPath: () => '/tmp/orivon-subsystem-test-does-not-touch-this' } as unknown as App
}

describe('loaderSubsystem', () => {
  it('is named "loader", per src/main/subsystems.ts\'s convention', () => {
    expect(loaderSubsystem.name).toBe('loader')
  })

  it('registers no beforeReady -- nothing here needs to run before the app is ready', () => {
    expect(loaderSubsystem.beforeReady).toBeUndefined()
  })

  it('afterReady constructs a real Loader and publishes it on ctx', async () => {
    const ctx = createSubsystemContext(fakeApp())
    expect(ctx.loader).toBeUndefined()

    await loaderSubsystem.afterReady?.(ctx)

    expect(ctx.loader).toBeDefined()
    expect(typeof ctx.loader?.load).toBe('function')
  })
})
