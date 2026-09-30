import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ShellServices } from '../../shell/shell-services.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { challenges } from '../auth-state.js'
import { installAuth } from '../install-auth.js'

vi.mock('electron', () => ({}))

describe('installAuth', () => {
  it('listens for the two questions and ends a closed tab\'s sign-ins', () => {
    const app = new EventEmitter()
    const listeners: Array<{ tabClosing?: (info: { id: string, window: unknown }) => void }> = []
    const window = { window: { id: 1 } } as unknown as ShellWindow
    const services = {
      windows: { findTab: () => null, all: () => [window] },
      tabLifecycle: { subscribe: (listener: (typeof listeners)[number]) => { listeners.push(listener); return () => undefined } }
    } as unknown as ShellServices
    installAuth.install(app as never, services, {} as never, {} as never)
    expect(app.listenerCount('login')).toBe(1)
    expect(app.listenerCount('select-client-certificate')).toBe(1)

    // Something that is not a tab is left alone: the event is not prevented and the callback never runs.
    const callback = vi.fn()
    let prevented = false
    app.emit('login', { preventDefault: () => { prevented = true } }, {}, { url: 'http://a.test/', firstAuthAttempt: true, isRequestForNavigation: true }, { isProxy: false, host: 'a.test', port: 80, realm: '' }, callback)
    expect({ prevented, called: callback.mock.calls.length }).toEqual({ prevented: false, called: 0 })

    // A client certificate asked for with no tab is answered with none, and the store's first one is not used.
    let certificatePrevented = false
    const pick = vi.fn()
    app.emit('select-client-certificate', { preventDefault: () => { certificatePrevented = true } }, null, 'https://a.test/', [{}], pick)
    expect(certificatePrevented).toBe(true)
    expect(pick).toHaveBeenCalledWith()

    const cancelled = vi.fn()
    const challenge = challenges.add({ owner: window, tabId: 'gone', load: 1, server: { scheme: 'http', host: 'a.test', port: 80, isProxy: false, realm: '' }, first: true, insecure: true, mismatch: false }, cancelled, () => undefined)
    expect(challenge).not.toBeNull()
    listeners[0]?.tabClosing?.({ id: 'gone', window: (window as unknown as { window: unknown }).window })
    expect(cancelled).toHaveBeenCalledWith(null)
  })
})
