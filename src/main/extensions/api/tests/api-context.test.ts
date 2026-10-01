import { describe, expect, it, vi } from 'vitest'
import { createApiContext, installExtensionApis, type ExtensionApiDeps } from '../api-context.js'
import type { ExtensionApiModule } from '../api-types.js'
import { createExtensionPrefsStore } from '../../extension-prefs-runner.js'
import { eventListenerFilter } from '../../extension-event-filter.js'
import { installPermissionCheck } from '../../extension-permission-check.js'

vi.mock('electron', () => ({ session: { defaultSession: { extensions: { getExtension: () => ({ manifest: { permissions: [] } }) } } } }))

const ID = 'a'.repeat(32)

function fakeDeps (over: Partial<ExtensionApiDeps> = {}) {
  const handlers = new Map<string, { run: (...a: any[]) => unknown, opts: Record<string, unknown> }>()
  const sendEvent = vi.fn()
  const host = {
    getRouter: () => ({
      apiHandler: () => (name: string, run: (...a: any[]) => unknown, opts: Record<string, unknown>) => { handlers.set(name, { run, opts }) },
      sendEvent
    })
  }
  const deps: ExtensionApiDeps = {
    host: host as never,
    session: { extensions: { getExtension: (id: string) => (id === ID ? { manifest: { manifest_version: 3, name: 'x', version: '1.0.0', host_permissions: ['https://a.example/*'] } } : null) } } as never,
    userDataPath: '/data',
    shell: () => undefined,
    extensions: () => undefined,
    prefs: createExtensionPrefsStore(null),
    held: () => true,
    isAppOrigin: (url) => url.startsWith('https://app.example'),
    webContentsFromId: () => undefined,
    ...over
  }
  return { deps, handlers, sendEvent }
}

const MODULE: ExtensionApiModule = { name: 'ns', permission: 'ns-perm', install: () => {} }

describe('createApiContext: handle', () => {
  it('registers on the router with the module permission by default', () => {
    const { deps, handlers } = fakeDeps()
    const run = vi.fn()
    createApiContext(deps, MODULE).handle('ns.get', run)
    expect(handlers.get('ns.get')).toEqual({ run, opts: { permission: 'ns-perm' } })
  })

  it('lets one handler name its own permission, or none at all', () => {
    const { deps, handlers } = fakeDeps()
    const ctx = createApiContext(deps, MODULE)
    ctx.handle('ns.a', vi.fn(), { permission: 'other' })
    ctx.handle('ns.b', vi.fn(), { permission: undefined })
    expect(handlers.get('ns.a')?.opts).toEqual({ permission: 'other' })
    expect(handlers.get('ns.b')?.opts).toEqual({})
  })

  it('registers a module with no permission without one', () => {
    const { deps, handlers } = fakeDeps()
    createApiContext(deps, { name: 'open', install: () => {} }).handle('open.x', vi.fn())
    expect(handlers.get('open.x')?.opts).toEqual({})
  })

  it('sends events through the router', () => {
    const { deps, sendEvent } = fakeDeps()
    createApiContext(deps, MODULE).sendEvent(ID, 'ns.onX', 1, 2)
    expect(sendEvent).toHaveBeenCalledWith(ID, 'ns.onX', 1, 2)
  })
})

describe('createApiContext: tab lookup', () => {
  function shellWith (contents: object | undefined, found: object | null) {
    const windows = { findTab: vi.fn(() => found), focused: vi.fn(), all: vi.fn(() => []) }
    return { deps: fakeDeps({ shell: () => ({ windows }) as never, webContentsFromId: () => contents as never }).deps, windows }
  }

  it('resolves a library tab id to its contents, window and shell tab id', () => {
    const contents = { isDestroyed: () => false }
    const window = { name: 'w' }
    const { deps } = shellWith(contents, { window, tabId: 't1' })
    expect(createApiContext(deps, MODULE).tab(5)).toEqual({ contents, window, id: 't1' })
  })

  it('refuses anything that is not a non-negative integer, and a destroyed or untracked tab', () => {
    const { deps } = shellWith({ isDestroyed: () => false }, null)
    const ctx = createApiContext(deps, MODULE)
    for (const bad of ['5', -1, 1.5, NaN, null, undefined, {}]) expect(ctx.tab(bad)).toBeUndefined()
    expect(ctx.tab(5)).toBeUndefined()
    expect(createApiContext(shellWith({ isDestroyed: () => true }, { window: {}, tabId: 't' }).deps, MODULE).tab(5)).toBeUndefined()
  })

  it('answers undefined before the first window exists', () => {
    const ctx = createApiContext(fakeDeps().deps, MODULE)
    expect(ctx.tab(1)).toBeUndefined()
    expect(ctx.activeTab()).toBeUndefined()
  })

  it('finds the active tab of the focused window, or of the window with that id', () => {
    const active = { isDestroyed: () => false }
    const entry = (id: number) => ({ window: { id, isDestroyed: () => false }, tabs: { activeWebContents: () => active } })
    const first = entry(1)
    const second = entry(2)
    const windows = {
      all: () => [first, second],
      focused: () => second,
      findTab: (c: unknown) => (c === active ? { window: second, tabId: 'tx' } : null)
    }
    const ctx = createApiContext(fakeDeps({ shell: () => ({ windows }) as never }).deps, MODULE)
    expect(ctx.activeTab()?.window).toBe(second)
    expect(ctx.activeTab(-2)?.id).toBe('tx')
    expect(ctx.activeTab(1)?.contents).toBe(active)
    expect(ctx.activeTab(99)).toBeUndefined()
  })
})

describe('createApiContext: canSee and isAppOrigin', () => {
  it('canSee asks the host access of the tab current URL for that extension', () => {
    const ctx = createApiContext(fakeDeps().deps, MODULE)
    expect(ctx.canSee(ID, { getURL: () => 'https://a.example/x', id: 1 } as never)).toBe(true)
    expect(ctx.canSee(ID, { getURL: () => 'https://b.example/x', id: 1 } as never)).toBe(false)
    expect(ctx.canSee('b'.repeat(32), { getURL: () => 'https://a.example/x', id: 1 } as never)).toBe(false)
  })

  it('passes the app-origin predicate through', () => {
    const ctx = createApiContext(fakeDeps().deps, MODULE)
    expect(ctx.isAppOrigin('https://app.example/')).toBe(true)
    expect(ctx.isAppOrigin('https://a.example/')).toBe(false)
  })
})

describe('installExtensionApis', () => {
  it('installs every module once, each with its own context', () => {
    const { deps, handlers } = fakeDeps()
    const one = vi.fn((ctx: { handle: (n: string, r: () => void) => void }) => { ctx.handle('one.x', () => {}) })
    const two = vi.fn((ctx: { handle: (n: string, r: () => void) => void }) => { ctx.handle('two.x', () => {}) })
    installExtensionApis(deps, [{ name: 'one', permission: 'p1', install: one }, { name: 'two', install: two }])
    expect(one).toHaveBeenCalledTimes(1)
    expect(two).toHaveBeenCalledTimes(1)
    expect(handlers.get('one.x')?.opts).toEqual({ permission: 'p1' })
    expect(handlers.get('two.x')?.opts).toEqual({})
  })

  it('makes the event filter require the module permission for its namespace', () => {
    const prefs = createExtensionPrefsStore(null)
    installPermissionCheck({ stripped: () => [], manifestPermissions: () => undefined, prefs }, () => {})
    const { deps } = fakeDeps({ prefs })
    installExtensionApis(deps, [{ name: 'gated', permission: 'gated-perm', install: () => {} }])
    expect(eventListenerFilter(ID, 'gated.onX', [1])).toBeUndefined()
    prefs.update(ID, { granted: { permissions: ['gated-perm'], origins: [] } })
    expect(eventListenerFilter(ID, 'gated.onX', [1])).toEqual([1])
  })
})
