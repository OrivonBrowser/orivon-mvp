import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OverlayWindow } from '../../overlays/overlay-types.js'
import { SHELL_EVENT_CHANNEL } from '../../channels.js'
import { createExtensionPrefsStore } from '../extension-prefs-runner.js'
import { extensionsMenuOverlay, createExtensionsMenu } from '../extensions-menu-overlay.js'
import type { ExtensionsMenuDeps } from '../extensions-menu-deps.js'
import { setExtensionsMenuDeps } from '../extensions-menu-deps.js'
import type { MenuPayload } from '../extensions-menu-model.js'
import * as points from '../extensions-menu-points.js'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const C = 'c'.repeat(32)
const ANCHOR = { x: 700, y: 40, width: 32, height: 32 }

interface Rig {
  handler: ReturnType<typeof createExtensionsMenu>
  deps: ExtensionsMenuDeps
  prefs: ReturnType<typeof createExtensionPrefsStore>
  close: ReturnType<typeof vi.fn>
  order: string[]
  tabs: Record<'openTrusted' | 'openInternal' | 'createTab', ReturnType<typeof vi.fn>>
  send: ReturnType<typeof vi.fn>
  published: ReturnType<typeof vi.fn>
  activate: ReturnType<typeof vi.fn>
  uninstall: ReturnType<typeof vi.fn>
}

function rig (options: { pinNew?: boolean, enabled?: string[], withAction?: string[], url?: string, internal?: boolean, canActivate?: boolean } = {}): Rig {
  const enabled = options.enabled ?? [A, B]
  const withAction = options.withAction ?? [A]
  const names: Record<string, string> = { [A]: 'Alpha', [B]: 'Beta', [C]: 'Gamma' }
  const prefs = createExtensionPrefsStore(null)
  const order: string[] = []
  const activate = vi.fn((id: string) => { order.push(`activate ${id}`) })
  const uninstall = vi.fn(async (id: string) => { enabled.splice(enabled.indexOf(id), 1) })
  const contents = { id: 41, isDestroyed: () => false }
  const tabs = { openTrusted: vi.fn(), openInternal: vi.fn(), createTab: vi.fn() }
  const send = vi.fn()
  const published = vi.fn()
  const deps: ExtensionsMenuDeps = {
    entries: async () => enabled.map((id) => ({ id, name: names[id] ?? id, icon: null, optionsUrl: id === A ? `chrome-extension://${A}/options.html` : undefined })),
    isEnabled: (id) => enabled.includes(id),
    optionsUrl: (id) => (id === A ? `chrome-extension://${A}/options.html` : undefined),
    actions: () => new Map(withAction.map((id) => [id, { hasPopup: id === A, badge: id === A ? '2' : '' }])),
    prefs,
    activate,
    canActivate: () => options.canActivate !== false,
    isLoaded: (id) => enabled.includes(id),
    uninstall
  }
  const close = vi.fn(() => { order.push('close') })
  const win = {
    window: {
      window: { getContentBounds: () => ({ width: 1000, height: 700 }) },
      chrome: { webContents: { isDestroyed: () => false, send } },
      tabs: {
        ...tabs,
        getState: () => ({ tabs: [{ id: 't1', url: options.url ?? 'https://example.com/page', isInternal: options.internal === true, isNewTab: false }], activeTabId: 't1' }),
        activeWebContents: () => contents
      }
    },
    services: { settings: { get: () => options.pinNew ?? true }, internalPages: { publish: published }, windows: { all: () => [] } },
    send: vi.fn(),
    close
  } as unknown as OverlayWindow
  return { handler: createExtensionsMenu(win, deps), deps, prefs, close, order, tabs, send, published, activate, uninstall }
}

const shown = async (r: Rig, opened: unknown = { anchor: ANCHOR }): Promise<MenuPayload> => (await r.handler.show?.(opened)) as MenuPayload

afterEach(() => { setExtensionsMenuDeps(undefined) })

describe('the overlay declaration', () => {
  it('is a 340px popup under the button that takes focus, is rebuilt each time and closes like a popup', () => {
    expect(extensionsMenuOverlay).toMatchObject({
      name: 'extensions-menu',
      placement: { kind: 'anchor', width: 340, align: 'right' },
      surface: 'panel', focus: 'take', layer: 'popup', keep: 'fresh', height: { max: 460 },
      closeOn: { blur: true, tabSwitch: true, navigation: false, layout: true }
    })
  })

  it('gives a window with no extension host a handler that does nothing', () => {
    const handler = extensionsMenuOverlay.attach({} as OverlayWindow)
    expect(handler.request({ type: 'store' })).toBeUndefined()
  })

  it('attaches to the installed dependencies', async () => {
    const r = rig()
    setExtensionsMenuDeps(r.deps)
    const handler = extensionsMenuOverlay.attach({ window: { chrome: { webContents: { isDestroyed: () => true } }, tabs: { getState: () => ({ tabs: [], activeTabId: null }), activeWebContents: () => undefined } }, services: { settings: { get: () => true } }, send: vi.fn(), close: vi.fn() } as unknown as OverlayWindow)
    const payload = await handler.show?.(undefined) as MenuPayload
    expect(payload.rows.map((row) => row.name)).toEqual(['Alpha', 'Beta'])
  })
})

describe('show', () => {
  it('lists every enabled extension, pinned first, with what each can do and the site in front', async () => {
    const r = rig()
    const payload = await shown(r)
    expect(payload.site).toBe('example.com')
    expect(payload.activatable).toBe(true)
    expect(payload.rows).toEqual([
      { id: A, name: 'Alpha', icon: null, pinned: true, hasAction: true, hasOptions: true, badge: '2', parts: {} },
      { id: B, name: 'Beta', icon: null, pinned: false, hasAction: false, hasOptions: false, badge: '', parts: {} }
    ])
  })

  it('follows extensions.pinNew for an extension never chosen for, and the person\'s choice over it', async () => {
    const off = rig({ pinNew: false })
    expect((await shown(off)).rows[0]?.pinned).toBe(false)
    off.prefs.update(A, { pinned: true })
    expect((await shown(off)).rows[0]?.pinned).toBe(true)
  })

  it('has no site on an internal page and says nothing can act there', async () => {
    const payload = await shown(rig({ url: 'orivon://settings/', internal: true, canActivate: false }))
    expect(payload.site).toBeNull()
    expect(payload.activatable).toBe(false)
  })

  it('lists nothing when no extension is enabled', async () => {
    expect((await shown(rig({ enabled: [] }))).rows).toEqual([])
  })

  it('tells the chrome the menu is open, and that it is closed again', async () => {
    const r = rig()
    await shown(r)
    r.handler.closed?.('escape')
    const events = r.send.mock.calls.map(([channel, event]) => [channel, event])
    expect(events).toEqual([
      [SHELL_EVENT_CHANNEL, { type: 'module', module: 'extensions-button', payload: { type: 'expanded', value: true } }],
      [SHELL_EVENT_CHANNEL, { type: 'module', module: 'extensions-button', payload: { type: 'expanded', value: false } }]
    ])
  })
})

describe('activate', () => {
  it('closes the menu first, then runs the action on the tab in front under the button', async () => {
    const r = rig()
    await shown(r)
    await r.handler.request({ type: 'activate', id: A })
    expect(r.order).toEqual(['close', `activate ${A}`])
    expect(r.activate).toHaveBeenCalledWith(A, expect.objectContaining({ id: 41 }), ANCHOR)
  })

  it('hangs under the toolbar\'s right end when the menu was opened without a button', async () => {
    const r = rig()
    await shown(r, null)
    await r.handler.request({ type: 'activate', id: A })
    expect(r.activate).toHaveBeenCalledWith(A, expect.anything(), { x: 888, y: 40, width: 32, height: 32 })
  })

  it('opens the details of an extension with no action instead', async () => {
    const r = rig()
    await shown(r)
    await r.handler.request({ type: 'activate', id: B })
    expect(r.activate).not.toHaveBeenCalled()
    expect(r.tabs.openInternal).toHaveBeenCalledWith('extensions', `/details?id=${B}`)
    expect(r.close).toHaveBeenCalled()
  })

  it('does nothing on a page no extension can act on, and keeps the menu open', async () => {
    const r = rig({ canActivate: false })
    await shown(r)
    await r.handler.request({ type: 'activate', id: A })
    expect(r.activate).not.toHaveBeenCalled()
    expect(r.close).not.toHaveBeenCalled()
  })

  it('survives an action that throws', async () => {
    const r = rig()
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(r.deps.activate as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('Unable to get active tab') })
    await expect(r.handler.request({ type: 'activate', id: A })).resolves.toBeUndefined()
    quiet.mockRestore()
  })
})

describe('pin', () => {
  it('toggles the pin and answers with the menu as it is now', async () => {
    const r = rig()
    const after = await r.handler.request({ type: 'pin', id: A }) as MenuPayload
    expect(r.prefs.get(A).pinned).toBe(false)
    expect(after.rows.find((row) => row.id === A)?.pinned).toBe(false)
    await r.handler.request({ type: 'pin', id: A })
    expect(r.prefs.get(A).pinned).toBe(true)
  })

  it('takes an explicit choice', async () => {
    const r = rig()
    await r.handler.request({ type: 'pin', id: A, pinned: true })
    await r.handler.request({ type: 'pin', id: A, pinned: true })
    expect(r.prefs.get(A).pinned).toBe(true)
  })
})

describe('options, manage, manage-all, store and remove', () => {
  it('opens the options page as a tab and closes the menu', async () => {
    const r = rig()
    await r.handler.request({ type: 'options', id: A })
    expect(r.tabs.openTrusted).toHaveBeenCalledWith(`chrome-extension://${A}/options.html`)
    expect(r.close).toHaveBeenCalled()
  })

  it('opens nothing for an extension with no options page', async () => {
    const r = rig()
    await r.handler.request({ type: 'options', id: B })
    expect(r.tabs.openTrusted).not.toHaveBeenCalled()
  })

  it('opens the details page of one extension, and the page of all', async () => {
    const r = rig()
    await r.handler.request({ type: 'manage', id: B })
    expect(r.tabs.openInternal).toHaveBeenLastCalledWith('extensions', `/details?id=${B}`)
    await r.handler.request({ type: 'manage-all' })
    expect(r.tabs.openInternal).toHaveBeenLastCalledWith('extensions')
  })

  it('opens the Chrome Web Store in a new tab', async () => {
    const r = rig({ enabled: [] })
    await r.handler.request({ type: 'store' })
    expect(r.tabs.createTab).toHaveBeenCalledWith('https://chromewebstore.google.com/category/extensions')
    expect(r.close).toHaveBeenCalled()
  })

  it('removes an extension, tells the extensions page and answers with the rest', async () => {
    const r = rig()
    const after = await r.handler.request({ type: 'remove', id: B }) as MenuPayload
    expect(r.uninstall).toHaveBeenCalledWith(B)
    expect(r.published).toHaveBeenCalledWith('extensions.changed', undefined, ['extensions'])
    expect(after.rows.map((row) => row.id)).toEqual([A])
  })
})

describe('a request that is not what the menu lists', () => {
  const forged: unknown[] = [
    undefined, null, 'activate', 7, [], {}, { type: 7 }, { type: 'nonsense', id: A }, { type: 'constructor', id: A }, { type: '__proto__', id: A },
    { type: 'activate' }, { type: 'activate', id: 'x' }, { type: 'activate', id: 'q'.repeat(32) }, { type: 'activate', id: C },
    { type: 'pin', id: C }, { type: 'remove', id: C }, { type: 'manage', id: 3 }, { type: 'options', id: `${A}/..` }
  ]

  it('does nothing', async () => {
    const r = rig()
    for (const command of forged) await expect(r.handler.request(command)).resolves.toBeUndefined()
    expect(r.activate).not.toHaveBeenCalled()
    expect(r.uninstall).not.toHaveBeenCalled()
    expect(r.tabs.openTrusted).not.toHaveBeenCalled()
    expect(r.tabs.openInternal).not.toHaveBeenCalled()
    expect(r.prefs.get(C).pinned).toBeNull()
  })

  it('does nothing for an extension that is installed but disabled', async () => {
    const r = rig({ enabled: [A] })
    await r.handler.request({ type: 'activate', id: B })
    await r.handler.request({ type: 'remove', id: B })
    expect(r.uninstall).not.toHaveBeenCalled()
    expect(r.tabs.openInternal).not.toHaveBeenCalled()
  })
})

describe('the extension points', () => {
  it('merges what a row part adds into the row, and survives one that throws', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rows = points.EXTENSION_MENU_ROW_PARTS as Array<(id: string) => Record<string, unknown>>
    rows.push((id) => ({ seen: id }), () => { throw new Error('broken') }, () => ({ extra: 1 }))
    try {
      const payload = await shown(rig())
      expect(payload.rows[0]?.parts).toEqual({ seen: A, extra: 1 })
    } finally {
      rows.length = 0
      quiet.mockRestore()
    }
  })

  it('runs a request a feature registered, with the id checked for it, and only an own key', async () => {
    const requests = points.EXTENSION_MENU_REQUESTS as Record<string, (body: Record<string, unknown>, ctx: points.MenuRequestContext) => unknown>
    const seen = vi.fn()
    requests['probe'] = (body, ctx) => { seen(ctx.extensionId(body)); return 'done' }
    try {
      const r = rig()
      await expect(r.handler.request({ type: 'probe', id: A })).resolves.toBe('done')
      await expect(r.handler.request({ type: 'probe', id: C })).resolves.toBe('done')
      expect(seen.mock.calls).toEqual([[A], [undefined]])
      await expect(r.handler.request({ type: 'toString', id: A })).resolves.toBeUndefined()
    } finally {
      delete requests['probe']
    }
  })
})
