import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// UPSTREAM.md patch 46: the toolbar list, a click started by Orivon's own
// code, the visibility check and the click interceptor, against the real
// BrowserActionAPI (reached through `(api as any)` as the sibling suites do).
vi.mock('electron', () => ({ Menu: class {}, MenuItem: class {}, nativeImage: {} }))

const { BrowserActionAPI, setActionClickInterceptor, setActionVisibilityCheck, setTabCaptureInvocationRecorder } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/api/browser-action.js'
)

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const ANCHOR = { x: 1, y: 2, width: 3, height: 4 }

function fakeCtx (tab: { id: number }): any {
  return {
    router: { apiHandler: () => vi.fn(), sendEvent: vi.fn() },
    session: { extensions: { on: vi.fn() } },
    store: {
      on: vi.fn(),
      getTabById: (id: number) => (id === tab.id ? tab : undefined),
      getActiveTabOfCurrentWindow: () => tab,
      tabToWindow: new Map(),
      tabDetailsCache: new Map()
    }
  }
}

function withActions (api: any): void {
  api.getAction(A).title = 'Alpha'
  api.getAction(A).popup = 'popup.html'
  api.getAction(B).title = 'Beta'
}

afterEach(() => {
  setActionVisibilityCheck(undefined as never)
  setActionClickInterceptor(undefined as never)
})

describe('listActions', () => {
  it('lists every action with its title and whether it has a popup', () => {
    const api = new BrowserActionAPI(fakeCtx({ id: 1 }))
    withActions(api)
    expect(api.listActions()).toEqual([
      { id: A, title: 'Alpha', hasPopup: true },
      { id: B, title: 'Beta', hasPopup: false }
    ])
  })

  it('leaves out an extension the visibility check hides, and the state the chrome view reads too', () => {
    const api = new BrowserActionAPI(fakeCtx({ id: 1 }))
    withActions(api)
    setActionVisibilityCheck((id: string) => id === B)
    expect(api.listActions().map((a: { id: string }) => a.id)).toEqual([B])
    expect((api as any).getState().actions.map((a: { id: string }) => a.id)).toEqual([B])
  })
})

describe('activateFromMain', () => {
  let recorder: ReturnType<typeof vi.fn<(extensionId: string, tab: unknown) => void>>
  beforeEach(() => {
    recorder = vi.fn()
    setTabCaptureInvocationRecorder(recorder)
  })

  it('counts as an invocation and dispatches onClicked for an action with no popup', () => {
    const tab = { id: 7 }
    const ctx = fakeCtx(tab)
    const api = new BrowserActionAPI(ctx)
    withActions(api)
    api.activateFromMain(B, tab as never, ANCHOR)
    expect(recorder).toHaveBeenCalledWith(B, tab)
    expect(ctx.router.sendEvent).toHaveBeenCalledWith(B, 'browserAction.onClicked', undefined)
  })

  it('stops after the invocation is counted when the interceptor handles the click', () => {
    const tab = { id: 7 }
    const ctx = fakeCtx(tab)
    const api = new BrowserActionAPI(ctx)
    withActions(api)
    const intercept = vi.fn(() => true)
    setActionClickInterceptor(intercept)
    api.activateFromMain(B, tab as never, ANCHOR)
    expect(intercept).toHaveBeenCalledWith(B, tab)
    expect(recorder).toHaveBeenCalledWith(B, tab)
    expect(ctx.router.sendEvent).not.toHaveBeenCalled()
  })

  it('carries on when the interceptor declines', () => {
    const tab = { id: 7 }
    const ctx = fakeCtx(tab)
    const api = new BrowserActionAPI(ctx)
    withActions(api)
    setActionClickInterceptor(() => false)
    api.activateFromMain(B, tab as never, ANCHOR)
    expect(ctx.router.sendEvent).toHaveBeenCalledTimes(1)
  })

  it('refuses a tab the library does not know', () => {
    const api = new BrowserActionAPI(fakeCtx({ id: 7 }))
    expect(() => { api.activateFromMain(A, { id: 99 } as never, ANCHOR) }).toThrow(/Unable to get active tab/)
  })
})

describe('notifyChanged', () => {
  it('tells every observer once, however many times it is called in a tick', async () => {
    const api = new BrowserActionAPI(fakeCtx({ id: 1 }))
    const send = vi.fn()
    ;(api as any).observers.add({ isDestroyed: () => false, send })
    api.notifyChanged()
    api.notifyChanged()
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('browserAction.update')
  })
})
