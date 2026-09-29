import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

// vendor/electron-chrome-extensions/src/browser/router.ts is reached from
// src/main/extensions/extension-host.ts only through a virtual specifier
// (electron-chrome-extensions-lib.d.ts's own header), never this real path --
// UPSTREAM.md patches 13-14 make router.ts itself satisfy the root
// tsconfig, so this suite can import it directly and drive its real
// `ipcMain.on('crx-add-listener'/'crx-remove-listener', ...)` handlers,
// instead of re-deriving their behaviour against a local fake.
const onHandlers = new Map<string, (...args: any[]) => unknown>()

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn((channel: string, fn: (...args: any[]) => unknown) => { onHandlers.set(channel, fn) })
  }
}))

const { ExtensionRouter, setMessageSenderIdCheck } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/router.js'
)

// getExtension defaults to an already-registered extension: these tests
// are about the sender-id check gating addListener/removeListener, not
// about UPSTREAM.md patch 38's own registration-race wait -- a session
// whose extension was never registered would make onAddListener wait
// (bounded, but still asynchronously) before ever reaching the (mocked)
// addListener call these tests assert on synchronously. The one test that
// specifically wants "not registered" overrides this explicitly.
function fakeSession (): Session {
  return {
    extensions: { on: vi.fn(), getExtension: vi.fn(() => ({ id: 'stub-extension', manifest: {} })) },
    serviceWorkers: { on: vi.fn() }
  } as unknown as Session
}

function frameEvent (session: Session): any {
  return { type: 'frame', sender: { session, once: vi.fn() }, senderFrame: null }
}

describe('crx-add-listener never throws synchronously out of the ipcMain.on listener', () => {
  it('for an extension no longer registered in the session, even when the sender names its own real id', () => {
    const session = fakeSession()
    const router = new ExtensionRouter(session)
    setMessageSenderIdCheck(() => true) // sender-id check passes; getExtension itself refuses below
    ;(session.extensions as any).getExtension = vi.fn(() => null)

    const id = 'a'.repeat(32)
    const event = { type: 'frame', sender: { session, once: vi.fn() }, senderFrame: { url: `chrome-extension://${id}/page.html` } }

    // router.addListener itself still throws (unchanged) -- the ipcMain.on
    // handler around it is what must never let that escape.
    expect(() => router.addListener({ type: 'frame', extensionId: id, host: event.sender as any }, id, 'tabs.onUpdated')).toThrow(/not registered/)
    expect(() => onHandlers.get('crx-add-listener')!(event, id, 'tabs.onUpdated')).not.toThrow()
    expect(() => onHandlers.get('crx-remove-listener')!(event, id, 'tabs.onUpdated')).not.toThrow()
  })
})

describe('crx-add-listener / crx-remove-listener sender-id check (UPSTREAM.md patch 9)', () => {
  it('refuses crx-add-listener when the sender-id check refuses the claimed extension', () => {
    const session = fakeSession()
    const router = new ExtensionRouter(session)
    const addSpy = vi.spyOn(router, 'addListener').mockImplementation(() => {})
    setMessageSenderIdCheck(() => false)

    const handler = onHandlers.get('crx-add-listener')
    expect(handler).toBeDefined()
    handler?.(frameEvent(session), 'claimed-extension-id', 'tabs.onUpdated')

    expect(addSpy).not.toHaveBeenCalled()
  })

  it('refuses crx-remove-listener when the sender-id check refuses the claimed extension', () => {
    const session = fakeSession()
    const router = new ExtensionRouter(session)
    const removeSpy = vi.spyOn(router, 'removeListener').mockImplementation(() => {})
    setMessageSenderIdCheck(() => false)

    const handler = onHandlers.get('crx-remove-listener')
    expect(handler).toBeDefined()
    handler?.(frameEvent(session), 'claimed-extension-id', 'tabs.onUpdated')

    expect(removeSpy).not.toHaveBeenCalled()
  })

  it('still reaches addListener/removeListener when the sender-id check allows it', () => {
    const session = fakeSession()
    const router = new ExtensionRouter(session)
    const addSpy = vi.spyOn(router, 'addListener').mockImplementation(() => {})
    const removeSpy = vi.spyOn(router, 'removeListener').mockImplementation(() => {})
    setMessageSenderIdCheck(() => true)

    onHandlers.get('crx-add-listener')?.(frameEvent(session), 'claimed-extension-id', 'tabs.onUpdated')
    onHandlers.get('crx-remove-listener')?.(frameEvent(session), 'claimed-extension-id', 'tabs.onUpdated')

    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(removeSpy).toHaveBeenCalledTimes(1)
  })
})
