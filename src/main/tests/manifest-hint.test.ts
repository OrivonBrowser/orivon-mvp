import { describe, expect, it, vi } from 'vitest'
import { createManifestHintListener, registerManifestHintIpc } from '../manifest-hint.js'
import type { IpcMainOnLike } from '../manifest-hint.js'
import { MANIFEST_HINT_CHANNEL } from '../channels.js'
import { APP, frameFor, NO_FRAME, OTHER, stubBroker } from '../../broker/transport/tests/ipc.test-helpers.js'
import { createTokenBucketLimiter } from '../../broker/transport/token-bucket.js'
import type { Broker } from '../../broker/broker-contracts.js'
import type { LoadResult, Loader } from '../../loader/index.js'

function fakeLoader (result: LoadResult): Loader & { load: ReturnType<typeof vi.fn> } {
  return { load: vi.fn(async () => result) }
}

/** installFromHint's own LoadContext build (Promise.all of these three)
 * needs all three to resolve -- app-install.test.ts's own `fakeBroker`
 * builds the same fixture; a bare `stubBroker([])` leaves them unconfigured
 * and rejecting, which this listener would then (correctly) log as an
 * unexpected failure instead of ever reaching the loader. */
function workingBroker (): Broker {
  return stubBroker([], {
    grants: async () => [],
    versionFloorFor: async () => '0.0.0',
    rollbackAcknowledgedVersionFor: async () => undefined
  })
}

const REJECTED: LoadResult = { outcome: 'rejected', reason: 'unused' }

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
    const loader = fakeLoader(REJECTED)
    const listener = createManifestHintListener({ broker: workingBroker(), loader })

    listener(frameFor(APP), 42)
    await flush()

    expect(loader.load).not.toHaveBeenCalled()
  })

  it('ignores an event with no authenticated origin (null/opaque frame), without ever touching the loader', async () => {
    const loader = fakeLoader(REJECTED)
    const listener = createManifestHintListener({ broker: workingBroker(), loader })

    listener(NO_FRAME, `${APP}/manifest.json`)
    await flush()

    expect(loader.load).not.toHaveBeenCalled()
  })

  // T3: the origin passed into installFromHint (and from there into the
  // broker) must come from the SENDER FRAME, never from the reported href.
  it('derives the origin from the sender frame, not from the reported hintedUrl', async () => {
    const loader = fakeLoader(REJECTED)
    const listener = createManifestHintListener({ broker: workingBroker(), loader })

    listener(frameFor(APP), `${APP}/manifest.json`)
    await flush()

    expect(loader.load).toHaveBeenCalledWith(`${APP}/manifest.json`, expect.anything())
  })

  it('rate-limits a repeated hint for the SAME origin, without starving a DIFFERENT origin', async () => {
    const loader = fakeLoader(REJECTED)
    const clock = manualClock()
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSecond: 1, now: clock.now })
    const listener = createManifestHintListener({ broker: workingBroker(), loader }, limiter)

    listener(frameFor(APP), `${APP}/manifest.json`)
    listener(frameFor(APP), `${APP}/manifest.json`) // same origin, same instant -- bucket already spent
    listener(frameFor(OTHER), `${OTHER}/manifest.json`) // a different origin has its own bucket
    await flush()

    expect(loader.load).toHaveBeenCalledTimes(2)
  })

  it('allows a repeated hint for the same origin again once the limiter has refilled', async () => {
    const loader = fakeLoader(REJECTED)
    const clock = manualClock()
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSecond: 1, now: clock.now })
    const listener = createManifestHintListener({ broker: workingBroker(), loader }, limiter)

    listener(frameFor(APP), `${APP}/manifest.json`)
    clock.advance(2_000)
    listener(frameFor(APP), `${APP}/manifest.json`)
    await flush()

    expect(loader.load).toHaveBeenCalledTimes(2)
  })

  // installFromHint's own outcomes past 'installed' are S4-3/S4-4/S4-5's
  // job to drive, not this lane's -- but a real outcome nobody acts on yet
  // must still be visible, never silently dropped.
  it('logs an outcome other than "installed" rather than dropping it silently', async () => {
    const loader = fakeLoader(REJECTED)
    const listener = createManifestHintListener({ broker: workingBroker(), loader })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    listener(frameFor(APP), `${APP}/manifest.json`)
    await flush()

    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('catches an unexpected rejection from installFromHint rather than crashing the ipcMain.on listener', async () => {
    const loader: Loader = { load: vi.fn(async () => { throw new Error('boom') }) }
    const listener = createManifestHintListener({ broker: workingBroker(), loader })
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

    registerManifestHintIpc(ipc, { broker: workingBroker(), loader: fakeLoader(REJECTED) })

    expect(on).toHaveBeenCalledExactlyOnceWith(MANIFEST_HINT_CHANNEL, expect.any(Function))
  })
})
