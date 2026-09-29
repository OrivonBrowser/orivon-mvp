import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

// Drives the REAL ExtensionRouter, the same way router-crx-msg-sender-id.test.ts
// does, against UPSTREAM.md patch 36 (router.ts's waitForRegisteredExtension):
// a genuine extension page can call a crx-msg handler in the same tick its own
// webContents is created, before session.extensions.getExtension(id) reflects
// the load already in flight (Volume Master's real popup.js calls
// chrome.tabs.query as its very first statement) -- this used to throw
// "was sent from an unknown extension context" outright; it should now wait
// briefly for 'extension-loaded' instead.
const handles = new Map<string, (...args: any[]) => unknown>()

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: any[]) => unknown) => { handles.set(channel, fn) }),
    on: vi.fn()
  }
}))

const { ExtensionRouter, setMessageSenderIdCheck } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/router.js'
)
const { senderMatchesClaimedExtensionId } = await import('../extension-sender-id-check.js')

/** A minimal but real event emitter for 'extension-loaded', standing in for
 * `session.extensions` -- fakeSession() in router-crx-msg-sender-id.test.ts
 * never needs to actually fire this event, so it stubs `on` with a bare
 * vi.fn(); this test needs the real thing. */
function fakeExtensions (): {
  getExtension: (id: string) => { id: string, manifest: Record<string, unknown> } | null
  on: (event: string, listener: (...args: any[]) => void) => void
  removeListener: (event: string, listener: (...args: any[]) => void) => void
  register: (extension: { id: string, manifest: Record<string, unknown> }) => void
} {
  const listeners = new Set<(...args: any[]) => void>()
  let registered: { id: string, manifest: Record<string, unknown> } | null = null
  return {
    getExtension: (id) => (registered?.id === id ? registered : null),
    on: (_event, listener) => { listeners.add(listener) },
    removeListener: (_event, listener) => { listeners.delete(listener) },
    register: (extension) => {
      registered = extension
      for (const listener of listeners) listener({}, extension)
    }
  }
}

describe('a crx-msg from a page whose extension is still registering', () => {
  it('waits for extension-loaded instead of refusing outright', async () => {
    const extensions = fakeExtensions()
    const session = { extensions, serviceWorkers: { on: vi.fn() } } as unknown as Session
    setMessageSenderIdCheck(senderMatchesClaimedExtensionId)
    const router = new ExtensionRouter(session)

    const senderId = 'a'.repeat(32)
    const query = vi.fn(async () => ['result'])
    router.apiHandler()('tabs.query', query)

    const event = {
      type: 'frame',
      sender: { session },
      senderFrame: { url: `chrome-extension://${senderId}/popup.html` }
    }

    // The real race: getExtension(senderId) answers null the whole time
    // the call is in flight, until the load already underway finishes and
    // fires 'extension-loaded' a moment later.
    setTimeout(() => { extensions.register({ id: senderId, manifest: {} }) }, 20)

    const result = await handles.get('crx-msg')!(event, senderId, 'tabs.query')

    expect(result).toEqual(['result'])
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('still refuses a page whose extension never registers, once the wait runs out', async () => {
    const extensions = fakeExtensions()
    const session = { extensions, serviceWorkers: { on: vi.fn() } } as unknown as Session
    setMessageSenderIdCheck(senderMatchesClaimedExtensionId)
    const router = new ExtensionRouter(session)

    const senderId = 'b'.repeat(32)
    router.apiHandler()('tabs.query', vi.fn())

    const event = {
      type: 'frame',
      sender: { session },
      senderFrame: { url: `chrome-extension://${senderId}/popup.html` }
    }

    await expect(handles.get('crx-msg')!(event, senderId, 'tabs.query')).rejects.toThrow(
      /unknown extension context/
    )
  }, 5000)
})
