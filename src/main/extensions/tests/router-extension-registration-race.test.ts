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
const onHandlers = new Map<string, (...args: any[]) => unknown>()

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: any[]) => unknown) => { handles.set(channel, fn) }),
    on: vi.fn((channel: string, fn: (...args: any[]) => unknown) => { onHandlers.set(channel, fn) })
  }
}))

const { ExtensionRouter, setMessageSenderIdCheck } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/router.js'
)
const { senderMatchesClaimedExtensionId } = await import('../extension-sender-id-check.js')

/** A minimal but real event emitter for 'extension-loaded', standing in for
 * `session.extensions` -- fakeSession() in router-crx-msg-sender-id.test.ts
 * never needs to actually fire this event, so it stubs `on` with a bare
 * vi.fn(); this test needs the real thing. `on`/`removeListener` are spies
 * so a test can assert how many 'extension-loaded' listeners were ever
 * added (UPSTREAM.md patch 38: one shared wait per extension id, not one
 * per call). */
function fakeExtensions (): {
  getExtension: (id: string) => { id: string, manifest: Record<string, unknown> } | null
  on: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  register: (extension: { id: string, manifest: Record<string, unknown> }) => void
} {
  const listeners = new Set<(...args: any[]) => void>()
  let registered: { id: string, manifest: Record<string, unknown> } | null = null
  const on = vi.fn((_event: string, listener: (...args: any[]) => void) => { listeners.add(listener) })
  const removeListener = vi.fn((_event: string, listener: (...args: any[]) => void) => { listeners.delete(listener) })
  return {
    getExtension: (id) => (registered?.id === id ? registered : null),
    on,
    removeListener,
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

describe('crx-add-listener from a page whose extension is still registering (UPSTREAM.md patch 38)', () => {
  it('waits for extension-loaded instead of losing the subscription outright', async () => {
    const extensions = fakeExtensions()
    const session = { extensions, serviceWorkers: { on: vi.fn() } } as unknown as Session
    setMessageSenderIdCheck(senderMatchesClaimedExtensionId)
    const router = new ExtensionRouter(session)

    const senderId = 'd'.repeat(32)
    const send = vi.fn()
    const sender = { session, id: 1, isDestroyed: () => false, send }
    const event = { type: 'frame', sender, senderFrame: { url: `chrome-extension://${senderId}/popup.html` } }

    // crx-add-listener is a fire-and-forget ipcMain.on, not a Promise --
    // this only proves the subscription is not lost, by observing its
    // eventual effect (sendEvent reaching the sender) once the extension
    // registers a moment later, the same real race the crx-msg case above
    // reproduces (a popup's own top-level
    // chrome.runtime.onMessage.addListener() call, before
    // session.extensions reflects its own load already in flight).
    onHandlers.get('crx-add-listener')!(event, senderId, 'runtime.onMessage')

    extensions.register({ id: senderId, manifest: {} })
    // Flushes every pending microtask the shared wait's own promise chain
    // needs before addListener actually runs.
    await new Promise((resolve) => setTimeout(resolve, 0))

    router.sendEvent(senderId, 'runtime.onMessage', 'payload')
    expect(send).toHaveBeenCalledWith('crx-runtime.onMessage', 'payload')
  })

  it('shares one pending wait (one extension-loaded listener) across concurrent callers racing the same extension id', async () => {
    const extensions = fakeExtensions()
    const session = { extensions, serviceWorkers: { on: vi.fn() } } as unknown as Session
    setMessageSenderIdCheck(senderMatchesClaimedExtensionId)
    const router = new ExtensionRouter(session)

    const senderId = 'e'.repeat(32)
    const query = vi.fn(async () => ['result'])
    router.apiHandler()('tabs.query', query)

    const send1 = vi.fn()
    const send2 = vi.fn()
    const popupEvent = {
      type: 'frame',
      sender: { session },
      senderFrame: { url: `chrome-extension://${senderId}/popup.html` }
    }
    const optionsEvent = { type: 'frame', sender: { session, id: 1, isDestroyed: () => false, send: send1 }, senderFrame: { url: `chrome-extension://${senderId}/options.html` } }
    const backgroundEvent = { type: 'frame', sender: { session, id: 2, isDestroyed: () => false, send: send2 }, senderFrame: { url: `chrome-extension://${senderId}/background.html` } }

    // Three concurrent callers, all racing the SAME still-registering
    // extension id -- a crx-msg call and two crx-add-listener calls, the
    // shape a real extension's popup (querying tabs) and two of its own
    // pages (subscribing to runtime.onMessage) produce if they all load
    // in the same instant.
    const queryPromise = handles.get('crx-msg')!(popupEvent, senderId, 'tabs.query')
    onHandlers.get('crx-add-listener')!(optionsEvent, senderId, 'runtime.onMessage')
    onHandlers.get('crx-add-listener')!(backgroundEvent, senderId, 'runtime.onMessage')

    // All three have started their own wait synchronously by now (nothing
    // above ever awaited) -- exactly one 'extension-loaded' listener
    // should exist, not three. (ExtensionRouter's own constructor also
    // subscribes to the unrelated 'extension-unloaded' once per router
    // instance -- filtered out here, not what this assertion is about.)
    const loadedRegistrations = extensions.on.mock.calls.filter((call: unknown[]) => call[0] === 'extension-loaded')
    expect(loadedRegistrations).toHaveLength(1)

    extensions.register({ id: senderId, manifest: {} })
    await queryPromise
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(query).toHaveBeenCalledTimes(1)
    router.sendEvent(senderId, 'runtime.onMessage', 'payload')
    expect(send1).toHaveBeenCalledWith('crx-runtime.onMessage', 'payload')
    expect(send2).toHaveBeenCalledWith('crx-runtime.onMessage', 'payload')

    // The one shared listener is cleaned up once resolved, not leaked.
    const loadedRemovals = extensions.removeListener.mock.calls.filter((call: unknown[]) => call[0] === 'extension-loaded')
    expect(loadedRemovals).toHaveLength(1)
  })
})

describe('crx-remove-listener arriving while its own crx-add-listener is still deferred (UPSTREAM.md patch 42)', () => {
  it('cancels the deferred add, instead of the listener coming back once registration finishes', async () => {
    const extensions = fakeExtensions()
    const session = { extensions, serviceWorkers: { on: vi.fn() } } as unknown as Session
    setMessageSenderIdCheck(senderMatchesClaimedExtensionId)
    const router = new ExtensionRouter(session)

    const senderId = 'f'.repeat(32)
    const send = vi.fn()
    const sender = { session, id: 3, isDestroyed: () => false, send }
    const event = { type: 'frame', sender, senderFrame: { url: `chrome-extension://${senderId}/popup.html` } }

    // Both arrive while the extension is still registering: the add
    // defers to the shared wait (patch 38), and the remove for the SAME
    // subscription follows immediately after, before that wait ever
    // resolves -- the exact race the review found: the remove finds
    // nothing yet added (a silent no-op), and the deferred add then runs
    // anyway once the extension registers, so the listener comes back.
    onHandlers.get('crx-add-listener')!(event, senderId, 'runtime.onMessage')
    onHandlers.get('crx-remove-listener')!(event, senderId, 'runtime.onMessage')

    extensions.register({ id: senderId, manifest: {} })
    await new Promise((resolve) => setTimeout(resolve, 0))

    router.sendEvent(senderId, 'runtime.onMessage', 'payload')
    expect(send).not.toHaveBeenCalled()
  })

  it('still adds the listener when the remove is for a DIFFERENT subscription', async () => {
    const extensions = fakeExtensions()
    const session = { extensions, serviceWorkers: { on: vi.fn() } } as unknown as Session
    setMessageSenderIdCheck(senderMatchesClaimedExtensionId)
    const router = new ExtensionRouter(session)

    const senderId = 'g'.repeat(32)
    const send = vi.fn()
    const sender = { session, id: 4, isDestroyed: () => false, send }
    const event = { type: 'frame', sender, senderFrame: { url: `chrome-extension://${senderId}/popup.html` } }
    const otherSend = vi.fn()
    const otherSender = { session, id: 5, isDestroyed: () => false, send: otherSend }
    const otherEvent = { type: 'frame', sender: otherSender, senderFrame: { url: `chrome-extension://${senderId}/other.html` } }

    onHandlers.get('crx-add-listener')!(event, senderId, 'runtime.onMessage')
    // A different host's subscription -- must not cancel the one above.
    onHandlers.get('crx-remove-listener')!(otherEvent, senderId, 'runtime.onMessage')

    extensions.register({ id: senderId, manifest: {} })
    await new Promise((resolve) => setTimeout(resolve, 0))

    router.sendEvent(senderId, 'runtime.onMessage', 'payload')
    expect(send).toHaveBeenCalledWith('crx-runtime.onMessage', 'payload')
  })
})
