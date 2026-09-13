import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loaderSubsystem } from '../subsystem.js'
import { createSubsystemContext } from '../../main/registry.js'
import type { App } from 'electron'

// A fake App, not a real one -- getPath is the only method afterReady
// actually calls. `restorePinnedServing` (electron-serve.ts) DOES touch the
// filesystem eagerly now -- a readdir of "<userData>/apps" -- but a fresh
// temp directory has no apps/ at all, so that read fails ENOENT, is caught,
// and the loop over origins never runs, meaning it never reaches the
// `import('electron')` inside registerServingFor either. That is what keeps
// this file's own tests real-Electron-free, the same guarantee
// brokerIpcSubsystem's own afterReady relies on (registry.ts's header) --
// not "nothing here touches the filesystem" any more.
async function fakeApp (): Promise<App> {
  const userData = await mkdtemp(join(tmpdir(), 'orivon-subsystem-test-'))
  return { getPath: () => userData } as unknown as App
}

afterEach(() => {
  globalThis.__orivonDevRegisterServing = undefined
})

describe('loaderSubsystem', () => {
  it('is named "loader", per src/main/subsystems.ts\'s convention', () => {
    expect(loaderSubsystem.name).toBe('loader')
  })

  it('registers no beforeReady -- nothing here needs to run before the app is ready', () => {
    expect(loaderSubsystem.beforeReady).toBeUndefined()
  })

  it('afterReady constructs a real Loader and publishes it on ctx', async () => {
    const ctx = createSubsystemContext(await fakeApp())
    expect(ctx.loader).toBeUndefined()

    await loaderSubsystem.afterReady?.(ctx)

    expect(ctx.loader).toBeDefined()
    expect(typeof ctx.loader?.load).toBe('function')
  })

  it('never installs the dev-serve hook under a plain vitest run, because the compiled-in flag is absent (dev-serve.ts, mirroring dev-grant.ts)', async () => {
    const ctx = createSubsystemContext(await fakeApp())

    await loaderSubsystem.afterReady?.(ctx)

    expect(globalThis.__orivonDevRegisterServing).toBeUndefined()
  })

  it('afterReady completes (restorePinnedServing runs and returns) against an empty, real userData directory with no apps installed', async () => {
    const ctx = createSubsystemContext(await fakeApp())

    await expect(loaderSubsystem.afterReady?.(ctx)).resolves.toBeUndefined()
  })
})
