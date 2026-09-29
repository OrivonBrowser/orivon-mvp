import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

// vendor/electron-chrome-extensions/src/browser/router.ts is reached from
// src/main/extensions/extension-host.ts only through a virtual specifier
// (electron-chrome-extensions-lib.d.ts's own header), never this real path --
// UPSTREAM.md patches 13-14 make router.ts itself satisfy the root
// tsconfig, so this suite can import it directly and drive its real
// sendEvent/broadcastEvent, the same way
// router-listener-sender-id.test.ts drives crx-add-listener/-remove-listener.
const onHandlers = new Map<string, (...args: any[]) => unknown>()

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn((channel: string, fn: (...args: any[]) => unknown) => { onHandlers.set(channel, fn) })
  }
}))

const { ExtensionRouter, setEventListenerFilter } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/router.js'
)

function fakeSession (): Session {
  return {
    extensions: { on: vi.fn(), getExtension: vi.fn(() => ({})) },
    serviceWorkers: { on: vi.fn() }
  } as unknown as Session
}

/** Typed `any`, like `router-listener-sender-id.test.ts`'s own `frameEvent`:
 * the real `EventListener` shape wants a full `Electron.WebContents`, and
 * this suite only ever calls `.send`/`.isDestroyed`/`.once` on the fake. */
function fakeHost (): any {
  return { id: 1, isDestroyed: () => false, send: vi.fn(), once: vi.fn() }
}

describe('router event-listener filter (UPSTREAM.md patch 15)', () => {
  it('delivers an event unchanged to every listener when no filter is set', () => {
    const session = fakeSession()
    const router = new ExtensionRouter(session)
    const host = fakeHost()
    router.addListener({ type: 'frame', host, extensionId: 'ext-a' }, 'ext-a', 'cookies.onChanged')

    router.broadcastEvent('cookies.onChanged', { cookie: 'unfiltered' })

    expect(host.send).toHaveBeenCalledWith('crx-cookies.onChanged', { cookie: 'unfiltered' })
  })

  it('skips a listener the filter refuses, while still delivering to one it allows', () => {
    const session = fakeSession()
    const router = new ExtensionRouter(session)
    const allowedHost = fakeHost()
    const refusedHost = fakeHost()
    router.addListener({ type: 'frame', host: allowedHost, extensionId: 'allowed' }, 'allowed', 'tabs.onUpdated')
    router.addListener({ type: 'frame', host: refusedHost, extensionId: 'refused' }, 'refused', 'tabs.onUpdated')

    setEventListenerFilter((extensionId: string, _eventName: string, args: readonly unknown[]) =>
      extensionId === 'refused' ? undefined : args)

    router.broadcastEvent('tabs.onUpdated', 1, { url: 'https://a.example/' })

    expect(allowedHost.send).toHaveBeenCalledWith('crx-tabs.onUpdated', 1, { url: 'https://a.example/' })
    expect(refusedHost.send).not.toHaveBeenCalled()
  })

  it('delivers whatever replacement args the filter returns, per listener', () => {
    const session = fakeSession()
    const router = new ExtensionRouter(session)
    const strippedHost = fakeHost()
    const fullHost = fakeHost()
    router.addListener({ type: 'frame', host: strippedHost, extensionId: 'stripped' }, 'stripped', 'tabs.onUpdated')
    router.addListener({ type: 'frame', host: fullHost, extensionId: 'full' }, 'full', 'tabs.onUpdated')

    setEventListenerFilter((extensionId: string, _eventName: string, args: readonly unknown[]) =>
      extensionId === 'stripped' ? [args[0], { pinned: false }] : args)

    router.broadcastEvent('tabs.onUpdated', 1, { url: 'https://a.example/', pinned: false })

    expect(strippedHost.send).toHaveBeenCalledWith('crx-tabs.onUpdated', 1, { pinned: false })
    expect(fullHost.send).toHaveBeenCalledWith('crx-tabs.onUpdated', 1, { url: 'https://a.example/', pinned: false })
  })
})
