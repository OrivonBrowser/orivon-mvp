import { describe, expect, it, vi } from 'vitest'
import { createManifestHintListener, registerManifestHintIpc } from '../manifest-hint.js'
import type { InstallApp, IpcMainOnLike } from '../manifest-hint.js'
import { MANIFEST_HINT_CHANNEL } from '../../channels.js'
import { APP, frameFor, NO_FRAME, OTHER } from '../../../broker/transport/tests/ipc.test-helpers.js'
import { createTokenBucketLimiter } from '../../../broker/transport/token-bucket.js'
import type { LoadResult } from '../../../loader/index.js'

const REJECTED: LoadResult = { outcome: 'rejected', reason: 'unused' }

/** The published `ctx.installApp`, spied. This listener takes that one
 * function rather than `AppInstallDeps`, so these tests assert at the seam
 * the production wiring actually uses -- see the listener's own doc for why
 * assembling deps here would let an install skip consent silently. */
function fakeInstallApp (): ReturnType<typeof vi.fn<InstallApp>> {
  return vi.fn<InstallApp>(async () => REJECTED)
}

/** Flushes a macrotask boundary -- installFromHint's own Promise.all/
 * withOriginQueue chain needs more than a bare microtask flush, the same
 * reasoning app-install.test.ts's own serialization test uses. */
async function flush (): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function manualClock (start = 0): { now: () => number, advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe('createManifestHintListener', () => {
  it('ignores a non-string hintedUrl without ever touching the loader', async () => {
    const installApp = fakeInstallApp()
    const listener = createManifestHintListener(installApp)

    listener(frameFor(APP), 42)
    await flush()

    expect(installApp).not.toHaveBeenCalled()
  })

  it('ignores an event with no authenticated origin (null/opaque frame), without ever touching the loader', async () => {
    const installApp = fakeInstallApp()
    const listener = createManifestHintListener(installApp)

    listener(NO_FRAME, `${APP}/manifest.json`)
    await flush()

    expect(installApp).not.toHaveBeenCalled()
  })

  // T3: the origin passed into installFromHint (and from there into the
  // broker) must come from the SENDER FRAME, never from the reported href.
  it('derives the origin from the sender frame, not from the reported hintedUrl', async () => {
    const installApp = fakeInstallApp()
    const listener = createManifestHintListener(installApp)

    listener(frameFor(APP), `${APP}/manifest.json`)
    await flush()

    // The FRAME's origin is what reaches the install path; the reported
    // href is passed through untouched for installFromHint's own
    // same-origin check to judge.
    expect(installApp).toHaveBeenCalledWith(APP, `${APP}/manifest.json`)
  })

  it('rate-limits a repeated hint for the SAME origin, without starving a DIFFERENT origin', async () => {
    const installApp = fakeInstallApp()
    const clock = manualClock()
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSecond: 1, now: clock.now })
    const listener = createManifestHintListener(installApp, limiter)

    listener(frameFor(APP), `${APP}/manifest.json`)
    listener(frameFor(APP), `${APP}/manifest.json`) // same origin, same instant -- bucket already spent
    listener(frameFor(OTHER), `${OTHER}/manifest.json`) // a different origin has its own bucket
    await flush()

    expect(installApp).toHaveBeenCalledTimes(2)
  })

  it('allows a repeated hint for the same origin again once the limiter has refilled', async () => {
    const installApp = fakeInstallApp()
    const clock = manualClock()
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSecond: 1, now: clock.now })
    const listener = createManifestHintListener(installApp, limiter)

    listener(frameFor(APP), `${APP}/manifest.json`)
    clock.advance(2_000)
    listener(frameFor(APP), `${APP}/manifest.json`)
    await flush()

    expect(installApp).toHaveBeenCalledTimes(2)
  })

  describe('reloading the tab that reported the hint', () => {
    const PIN = { schema: 1 as const, origin: APP, bundleHash: 'sha256:' + 'a'.repeat(64), assets: [], version: '1.0.0', pinnedAt: 0 }
    const MANIFEST = { orivonApiVersion: 0 as const, id: 'app.test', name: 'Test', version: '1.0.0', entry: 'index.html', capabilities: {} }

    function reportingTab (): { reload: ReturnType<typeof vi.fn<() => void>>, isDestroyed: () => boolean } {
      return { reload: vi.fn<() => void>(), isDestroyed: () => false }
    }

    it('reloads once after an install that newly registered the app, so the tab is rebuilt with its app-tab flag', async () => {
      const installApp = vi.fn<InstallApp>(async () => ({ outcome: 'installed', canonicalOrigin: APP, manifest: MANIFEST, pin: PIN, newlyRegistered: true }))
      const sender = reportingTab()
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      createManifestHintListener(installApp)({ ...frameFor(APP), sender }, `${APP}/`)
      await flush()

      expect(sender.reload).toHaveBeenCalledOnce()
      logSpy.mockRestore()
    })

    it('does not reload after an install for an app that was already registered', async () => {
      const installApp = vi.fn<InstallApp>(async () => ({ outcome: 'installed', canonicalOrigin: APP, manifest: MANIFEST, pin: PIN }))
      const sender = reportingTab()

      createManifestHintListener(installApp)({ ...frameFor(APP), sender }, `${APP}/`)
      await flush()

      expect(sender.reload).not.toHaveBeenCalled()
    })

    it('does not reload a tab that was closed while the install ran', async () => {
      const installApp = vi.fn<InstallApp>(async () => ({ outcome: 'installed', canonicalOrigin: APP, manifest: MANIFEST, pin: PIN, newlyRegistered: true }))
      const sender = { reload: vi.fn<() => void>(), isDestroyed: () => true }
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      createManifestHintListener(installApp)({ ...frameFor(APP), sender }, `${APP}/`)
      await flush()

      expect(sender.reload).not.toHaveBeenCalled()
      logSpy.mockRestore()
    })
  })

  // installFromHint's own outcomes past 'installed' are S4-3/S4-4/S4-5's
  // job to drive, not this lane's -- but a real outcome nobody acts on yet
  // must still be visible, never silently dropped.
  it('logs an outcome other than "installed" rather than dropping it silently', async () => {
    const installApp = fakeInstallApp()
    const listener = createManifestHintListener(installApp)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    listener(frameFor(APP), `${APP}/manifest.json`)
    await flush()

    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('catches an unexpected rejection from the install path rather than crashing the ipcMain.on listener', async () => {
    const installApp = vi.fn<InstallApp>(async () => { throw new Error('boom') })
    const listener = createManifestHintListener(installApp)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => { listener(frameFor(APP), `${APP}/manifest.json`) }).not.toThrow()
    await flush()

    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('registerManifestHintIpc', () => {
  it('registers exactly one ipcMain.on handler on MANIFEST_HINT_CHANNEL', () => {
    const on = vi.fn()
    const ipc: IpcMainOnLike = { on }

    registerManifestHintIpc(ipc, fakeInstallApp())

    expect(on).toHaveBeenCalledExactlyOnceWith(MANIFEST_HINT_CHANNEL, expect.any(Function))
  })
})
