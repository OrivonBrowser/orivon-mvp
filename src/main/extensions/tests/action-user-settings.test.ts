import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import type { ShellServices } from '../../shell/shell-services.js'
import type { ExtensionApiContext, ApiEvent } from '../api/api-types.js'
import { createExtensionPrefsStore } from '../extension-prefs-runner.js'
import { extensionsMenuDeps, setExtensionsMenuDeps } from '../extensions-menu-deps.js'

// The vendored router, driven for real: a second `handle` of one name replaces the first, which is how
// this module answers `chrome.action.getUserSettings` over the library's own answer.
const onHandlers = new Map<string, (...args: any[]) => unknown>()
vi.mock('electron', () => ({ app: { on: vi.fn() }, ipcMain: { handle: vi.fn(), on: vi.fn((channel: string, fn: (...args: any[]) => unknown) => { onHandlers.set(channel, fn) }) } }))

let visibility: ((id: string) => boolean) | undefined
let menuBuilder: ((id: string, items: unknown[]) => Array<Record<string, unknown>>) | undefined
vi.mock('orivon:crx-extensions-browser-action', () => ({
  setActionVisibilityCheck: (check: (id: string) => boolean) => { visibility = check },
  setActionMenuBuilder: (builder: typeof menuBuilder) => { menuBuilder = builder }
}))
let sidePanelAction: (() => void) | undefined
vi.mock('../side-panel-runner.js', () => ({ sidePanelMenuAction: () => sidePanelAction }))
vi.mock('../extensions-view-runner.js', () => ({
  readExtensionFacts: async (entry: { name: string }) => ({ resolvedName: entry.name, resolvedDescription: undefined, iconDataUrl: undefined, manifestFacts: undefined })
}))

const { ExtensionRouter } = await import('../../../../vendor/electron-chrome-extensions/src/browser/router.js')
const { actionUserSettingsApi, watchPinSetting } = await import('../action-pins-runner.js')

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)

interface Rig {
  ctx: ExtensionApiContext
  prefs: ReturnType<typeof createExtensionPrefsStore>
  handlers: Map<string, (event: ApiEvent) => unknown>
  sendEvent: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  pinNew: { value: boolean }
  settingListeners: Array<(change: { key: string }) => void>
  tabs: Record<'openTrusted' | 'openInternal', ReturnType<typeof vi.fn>>
  activate: ReturnType<typeof vi.fn>
}

function rig (): Rig {
  const prefs = createExtensionPrefsStore(null)
  const handlers = new Map<string, (event: ApiEvent) => unknown>()
  const sendEvent = vi.fn()
  const notify = vi.fn()
  const pinNew = { value: true }
  const settingListeners: Array<(change: { key: string }) => void> = []
  const tabs = { openTrusted: vi.fn(), openInternal: vi.fn() }
  const activate = vi.fn()
  const extensions = new Map<string, { name: string, manifest: Record<string, unknown> }>([
    [A, { name: 'Alpha', manifest: { options_page: 'o.html' } }],
    [B, { name: 'Beta', manifest: {} }]
  ])
  const services = {
    settings: { get: () => pinNew.value, onChange: (listener: (change: { key: string }) => void) => { settingListeners.push(listener); return () => {} } },
    windows: { focused: () => ({ tabs }), all: () => [] }
  } as unknown as ShellServices
  const ctx = {
    handle: (name: string, run: (event: ApiEvent) => unknown) => { handlers.set(name, run) },
    sendEvent,
    host: {
      notifyActionsChanged: notify,
      listAllActions: () => [{ id: A, title: 'Alpha', hasPopup: true, badge: '4' }],
      activateAction: activate
    },
    session: { extensions: { getExtension: (id: string) => extensions.get(id) ?? null } } as unknown as Session,
    shell: () => services,
    extensions: () => ({
      list: () => [{ id: A, name: 'Alpha', enabled: true }, { id: B, name: 'Beta', enabled: false }],
      uninstall: vi.fn()
    }),
    prefs
  } as unknown as ExtensionApiContext
  actionUserSettingsApi.install(ctx)
  watchPinSetting(services)
  return { ctx, prefs, handlers, sendEvent, notify, pinNew, settingListeners, tabs, activate }
}

const event = (id: string): ApiEvent => ({ type: 'frame', sender: undefined, extension: { id, manifest: {} } })

afterEach(() => { setExtensionsMenuDeps(undefined); visibility = undefined; menuBuilder = undefined; sidePanelAction = undefined })

describe('chrome.action.getUserSettings', () => {
  it('answers the real pin state, following the setting until the person chooses', () => {
    const r = rig()
    const answer = r.handlers.get('browserAction.getUserSettings')
    expect(answer?.(event(A))).toEqual({ isOnToolbar: true })
    r.pinNew.value = false
    expect(answer?.(event(A))).toEqual({ isOnToolbar: false })
    r.prefs.update(A, { pinned: true })
    expect(answer?.(event(A))).toEqual({ isOnToolbar: true })
    r.prefs.update(B, { pinned: false })
    r.pinNew.value = true
    expect(answer?.(event(B))).toEqual({ isOnToolbar: false })
  })

  it('replaces the library\'s own answer on the real router', async () => {
    const r = rig()
    const session = { extensions: { on: vi.fn(), getExtension: () => ({ id: A, manifest: {} }) }, serviceWorkers: { on: vi.fn() } } as unknown as Session
    const router = new ExtensionRouter(session)
    const handle = router.apiHandler()
    handle('browserAction.getUserSettings', () => ({ isOnToolbar: true }))
    // The module registers the same way ctx.handle does, so it lands as the later entry of the same name.
    const mine = r.handlers.get('browserAction.getUserSettings')
    expect(mine).toBeDefined()
    handle('browserAction.getUserSettings', (e: ApiEvent) => mine?.(e))
    r.prefs.update(A, { pinned: false })
    const frame: any = { type: 'frame', sender: { session, id: 1 } }
    await expect(router.onExtensionMessage(frame, A, 'browserAction.getUserSettings')).resolves.toEqual({ isOnToolbar: false })
  })
})

describe('the toolbar list', () => {
  it('shows only the pinned extensions', () => {
    const r = rig()
    r.prefs.update(B, { pinned: false })
    expect(visibility?.(A)).toBe(true)
    expect(visibility?.(B)).toBe(false)
  })
})

describe('onUserSettingsChanged', () => {
  it('tells an extension its pin changed, and refreshes the toolbar, once per real change', () => {
    const r = rig()
    visibility?.(A)
    r.notify.mockClear()
    r.prefs.update(A, { pinned: false })
    expect(r.sendEvent).toHaveBeenCalledWith(A, 'action.onUserSettingsChanged', { isOnToolbar: false })
    expect(r.notify).toHaveBeenCalledTimes(1)
    r.sendEvent.mockClear()
    r.prefs.update(A, { granted: { permissions: ['tabs'], origins: [] } })
    expect(r.sendEvent).not.toHaveBeenCalled()
    r.prefs.update(A, { pinned: true })
    expect(r.sendEvent).toHaveBeenCalledWith(A, 'action.onUserSettingsChanged', { isOnToolbar: true })
  })

  it('moves every extension that follows the setting when the setting changes, and no other', () => {
    const r = rig()
    visibility?.(A)
    visibility?.(B)
    r.prefs.update(B, { pinned: true })
    r.sendEvent.mockClear()
    r.pinNew.value = false
    for (const listener of r.settingListeners) listener({ key: 'appearance.theme' })
    expect(r.sendEvent).not.toHaveBeenCalled()
    for (const listener of r.settingListeners) listener({ key: 'extensions.pinNew' })
    expect(r.sendEvent.mock.calls).toEqual([[A, 'action.onUserSettingsChanged', { isOnToolbar: false }]])
  })
})

describe('the right-click menu of an action', () => {
  it('is Orivon\'s, naming the extension, with Options only when it has a page', () => {
    rig()
    const template = menuBuilder?.(A, []) ?? []
    expect(template.map((item) => item['label'] ?? item['type'])).toEqual(['Alpha', 'separator', 'Options', 'Unpin from Toolbar', 'Manage Extension', 'Remove from Orivon…'])
    expect(template[2]).toMatchObject({ enabled: true })
    expect(menuBuilder?.(B, [])[2]).toMatchObject({ label: 'Options', enabled: false })
  })

  it('adds Open Side Panel when the side panel runner has an opener for the extension', () => {
    rig()
    const open = vi.fn()
    sidePanelAction = open
    const template = menuBuilder?.(A, []) ?? []
    expect(template.map((item) => item['label'] ?? item['type'])).toContain('Open Side Panel')
    ;(template[2]?.['click'] as () => void)()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('pins, opens and manages through the focused window', () => {
    const r = rig()
    const template = menuBuilder?.(A, []) ?? []
    ;(template[2]?.['click'] as () => void)()
    expect(r.tabs.openTrusted).toHaveBeenCalledWith(`chrome-extension://${A}/o.html`)
    ;(template[3]?.['click'] as () => void)()
    expect(r.prefs.get(A).pinned).toBe(false)
    expect(menuBuilder?.(A, [])[3]).toMatchObject({ label: 'Pin to Toolbar' })
    ;(template[4]?.['click'] as () => void)()
    expect(r.tabs.openInternal).toHaveBeenLastCalledWith('extensions', `/details?id=${A}`)
    ;(template[5]?.['click'] as () => void)()
    expect(r.tabs.openInternal).toHaveBeenLastCalledWith('extensions', `/details?id=${A}`)
  })
})

describe('the dependencies of the Extensions menu', () => {
  it('lists the enabled extensions, their actions with badges, and runs one', async () => {
    const r = rig()
    const deps = extensionsMenuDeps()
    expect(await deps?.entries()).toEqual([{ id: A, name: 'Alpha', icon: null, optionsUrl: `chrome-extension://${A}/o.html` }])
    expect(deps?.isEnabled(A)).toBe(true)
    expect(deps?.isEnabled(B)).toBe(false)
    expect(deps?.actions(9).get(A)).toEqual({ hasPopup: true, badge: '4' })
    expect(deps?.optionsUrl(B)).toBeUndefined()
    const tab = { session: r.ctx.session } as never
    expect(deps?.canActivate(tab)).toBe(true)
    expect(deps?.canActivate({ session: {} } as never)).toBe(false)
    deps?.activate(A, tab, { x: 1, y: 2, width: 3, height: 4 })
    expect(r.activate).toHaveBeenCalledWith(A, tab, { x: 1, y: 2, width: 3, height: 4 })
  })
})
