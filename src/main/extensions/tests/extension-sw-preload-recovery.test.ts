import { describe, expect, it, vi } from 'vitest'
import { watchForMissedServiceWorkerPreload } from '../extension-sw-preload-recovery.js'
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
