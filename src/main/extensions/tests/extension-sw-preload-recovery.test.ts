// createPreloadRecovery's own onReloadBoundary contract: called once before
// removeExtension ('start') and once after loadExtension settles ('end'),
// on both success and failure -- extensions-dnr.ts's beginDnrReload/
// endDnrReload (wired at extension-host.ts's call site, never imported
// here: this file's own header says why) rely on 'end' always firing so a
// marked id is never left stuck.
import { describe, expect, it, vi } from 'vitest'
import {
  createPreloadRecovery, extensionIdFromScope, watchForMissedServiceWorkerPreload, type PreloadRecoveryDeps
} from '../extension-sw-preload-recovery.js'
import { EXTENSION_SW_HEALTH_REPLY_CHANNEL } from '../../channels.js'

const EXT_ID = 'a'.repeat(32)

function fakeSession (loadExtension: (path: string) => Promise<unknown>) {
  const runningStatusHandlers: Array<(event: { runningStatus: string, versionId: number }) => void> = []
  const replyHandlers = new Map<number, (event: unknown, ok: boolean) => void>()

  const worker = {
    scope: `chrome-extension://${EXT_ID}/background.js`,
    send: vi.fn(),
    ipc: {
      once: vi.fn((channel: string, fn: (event: unknown, ok: boolean) => void) => {
        if (channel === EXTENSION_SW_HEALTH_REPLY_CHANNEL) replyHandlers.set(1, fn)
      })
    }
  }

  const session = {
    extensions: {
      getExtension: vi.fn(() => ({ path: '/ext/path' })),
      removeExtension: vi.fn()
    },
    serviceWorkers: {
      on: vi.fn((eventName: string, fn: any) => { if (eventName === 'running-status-changed') runningStatusHandlers.push(fn) }),
      getWorkerFromVersionID: vi.fn(() => worker)
    }
  } as any
  session.extensions.loadExtension = loadExtension

  return {
    session,
    start: () => runningStatusHandlers[0]?.({ runningStatus: 'running', versionId: 1 }),
    replyNotOk: () => replyHandlers.get(1)?.(undefined, false)
  }
}

describe('watchForMissedServiceWorkerPreload: a failed recovery never becomes an unhandled rejection', () => {
  it('a rejected loadExtension inside handleUnhealthyWorker is caught and logged, not left to reject silently', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const loadExtension = vi.fn(async () => { throw new Error('boom') })
    const { session, start, replyNotOk } = fakeSession(loadExtension)

    watchForMissedServiceWorkerPreload(session)
    start()
    replyNotOk()

    // Let the rejected promise's own .catch handler run.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    expect(loadExtension).toHaveBeenCalledWith('/ext/path', { allowFileAccess: false })
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to recover'),
      expect.any(Error)
    )
    errorSpy.mockRestore()
  })
})

const SCOPE = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/'
const ID = 'abcdefghijklmnopabcdefghijklmnop'

function baseDeps (overrides: Partial<PreloadRecoveryDeps> = {}): PreloadRecoveryDeps {
  return {
    getExtensionPath: () => '/fake/path',
    removeExtension: vi.fn(),
    loadExtension: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('extensionIdFromScope', () => {
  it('extracts the id from a chrome-extension:// scope', () => {
    expect(extensionIdFromScope(SCOPE)).toBe(ID)
  })

  it('is undefined for anything else', () => {
    expect(extensionIdFromScope('https://example.com/')).toBeUndefined()
    expect(extensionIdFromScope('chrome-extension://tooshort/')).toBeUndefined()
  })
})

describe('createPreloadRecovery: onReloadBoundary', () => {
  it('fires \'start\' before removeExtension and \'end\' after loadExtension settles, in that order', async () => {
    const calls: string[] = []
    const deps = baseDeps({
      removeExtension: () => { calls.push('removeExtension') },
      loadExtension: async () => { calls.push('loadExtension'); return undefined },
    })
    const onReloadBoundary = vi.fn((id: string, phase: 'start' | 'end') => { calls.push(`${phase}:${id}`) })
    const recovery = createPreloadRecovery({ ...deps, onReloadBoundary })

    await recovery.handleUnhealthyWorker(SCOPE)

    expect(calls).toEqual([`start:${ID}`, 'removeExtension', 'loadExtension', `end:${ID}`])
  })

  it('still fires \'end\' when loadExtension rejects -- a marked id must never be left stuck', async () => {
    const onReloadBoundary = vi.fn()
    const deps = baseDeps({ loadExtension: async () => { throw new Error('boom') }, onReloadBoundary })
    const recovery = createPreloadRecovery(deps)

    await expect(recovery.handleUnhealthyWorker(SCOPE)).rejects.toThrow('boom')

    expect(onReloadBoundary).toHaveBeenNthCalledWith(1, ID, 'start')
    expect(onReloadBoundary).toHaveBeenNthCalledWith(2, ID, 'end')
  })

  it('is never called at all when it is left out (a caller with nothing to protect)', async () => {
    const recovery = createPreloadRecovery(baseDeps())
    await expect(recovery.handleUnhealthyWorker(SCOPE)).resolves.toBeUndefined()
  })

  it('is never called for a scope with no resolvable extension id, or an already-retried one', async () => {
    const onReloadBoundary = vi.fn()
    const recovery = createPreloadRecovery(baseDeps({ onReloadBoundary }))

    await recovery.handleUnhealthyWorker('https://not-an-extension/')
    expect(onReloadBoundary).not.toHaveBeenCalled()

    await recovery.handleUnhealthyWorker(SCOPE)
    onReloadBoundary.mockClear()
    await recovery.handleUnhealthyWorker(SCOPE) // second report for the same id -- bounded to one retry
    expect(onReloadBoundary).not.toHaveBeenCalled()
  })
})
