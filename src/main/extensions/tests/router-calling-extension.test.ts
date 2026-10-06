import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

// UPSTREAM.md patch 68: callingExtensionId() names the extension whose API call is running, from inside the
// callbacks that call reaches (the embedder's createTab and selectTab are not told who asked). Driven against
// the real router.ts, as router-permission-check.test.ts is.
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

const { ExtensionRouter, callingExtensionId } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/router.js'
)

function fakeSession (extension: unknown): Session {
  return {
    extensions: { on: vi.fn(), getExtension: vi.fn(() => extension) },
    serviceWorkers: { on: vi.fn() }
  } as unknown as Session
}

const frameEvent = (session: Session): any => ({ type: 'frame', sender: { session, id: 1 } })

describe('callingExtensionId (UPSTREAM.md patch 68)', () => {
  it('names the calling extension inside its handler, across awaits, and nobody outside it', async () => {
    const session = fakeSession({ id: 'ext-1', manifest: {} })
    const router = new ExtensionRouter(session)
    const seen: Array<string | undefined> = []
    router.apiHandler()('test.method', async () => {
      seen.push(callingExtensionId())
      await new Promise((resolve) => setImmediate(resolve))
      seen.push(callingExtensionId())
    })

    expect(callingExtensionId()).toBeUndefined()
    await router.onExtensionMessage(frameEvent(session), 'ext-1', 'test.method')
    expect(seen).toEqual(['ext-1', 'ext-1'])
    expect(callingExtensionId()).toBeUndefined()
  })

  it('keeps two calls in flight apart', async () => {
    const one = fakeSession({ id: 'ext-1', manifest: {} })
    const two = fakeSession({ id: 'ext-2', manifest: {} })
    const first = new ExtensionRouter(one)
    const second = new ExtensionRouter(two)
    const seen: string[] = []
    const record = async (): Promise<void> => {
      await new Promise((resolve) => setImmediate(resolve))
      seen.push(String(callingExtensionId()))
    }
    first.apiHandler()('test.method', record)
    second.apiHandler()('test.method', record)

    await Promise.all([
      first.onExtensionMessage(frameEvent(one), 'ext-1', 'test.method'),
      second.onExtensionMessage(frameEvent(two), 'ext-2', 'test.method')
    ])
    expect(seen.sort()).toEqual(['ext-1', 'ext-2'])
  })
})
