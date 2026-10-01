import { describe, expect, it, vi } from 'vitest'
import type { ApiEvent, ExtensionApiContext } from '../api/api-types.js'
import { createExtensionPrefsStore } from '../extension-prefs-runner.js'
import { setGrantedHostSource } from '../granted-host-rule.js'
import { createNagLimit } from '../permission-nag-limit.js'
import {
  BUSY_ERROR, GESTURE_ERROR, installPermissions, NAGGING_ERROR, NEVER_ERROR, parseRequest, UNDECLARED_ERROR,
  type PermissionsApiDeps
} from '../permissions-api.js'

vi.mock('electron', () => ({ app: { on: vi.fn() }, session: { defaultSession: {} } }))

const ID = 'a'.repeat(32)
const MANIFEST = {
  manifest_version: 3,
  name: 'Tidy Tabs',
  permissions: ['storage'],
  host_permissions: ['https://required.example/*'],
  optional_permissions: ['history', 'bookmarks', 'webRequest'],
  optional_host_permissions: ['https://*.example.com/*']
}

type Handler = (event: ApiEvent, ...args: unknown[]) => unknown

function setup (over: Partial<PermissionsApiDeps> = {}, manifest: Record<string, unknown> = MANIFEST) {
  const handlers = new Map<string, Handler>()
  const prefs = createExtensionPrefsStore(null)
  const sendEvent = vi.fn()
  const applyManifest = vi.fn(async () => 'applied')
  const ctx = {
    handle: (name: string, run: Handler) => { handlers.set(name, run) },
    sendEvent,
    prefs,
    held: () => false,
    extensions: () => ({ applyManifest, list: () => [] }),
    session: { extensions: { getExtension: () => ({ id: ID }) } }
  } as unknown as ExtensionApiContext
  const window = { name: 'window' }
  const ask = vi.fn(async () => true)
  installPermissions(ctx, {
    target: () => ({ window: window as never, tabId: 't1' }),
    ask,
    identity: async () => ({ name: 'Tidy Tabs', icon: undefined }),
    nag: createNagLimit(),
    ...over
  })
  const event = (type: 'frame' | 'service-worker' = 'frame'): ApiEvent => ({ type, sender: undefined, extension: { id: ID, manifest } })
  const call = async (name: string, ...args: unknown[]): Promise<unknown> => await (handlers.get(name) as Handler)(event(), ...args)
  return { handlers, prefs, sendEvent, applyManifest, ask, event, call, window }
}

describe('registration', () => {
  it('registers the six calls, with no permission of its own', () => {
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual([
      'permissions.addHostAccessRequest', 'permissions.contains', 'permissions.getAll', 'permissions.remove',
      'permissions.removeHostAccessRequest', 'permissions.request'
    ])
  })

  it('hands the prefs to the granted-host rule', () => {
    setup()
    setGrantedHostSource(undefined)
  })
})

describe('parseRequest', () => {
  it('accepts permissions and origins and nothing else', () => {
    expect(parseRequest({ permissions: ['history'] })).toEqual({ permissions: ['history'], origins: [] })
    for (const bad of [null, 'x', [], { permissions: 'history' }, { permissions: [1] }, { permissions: [''] }, { extra: true },
      { origins: new Array(51).fill('https://a.example/*') }, { permissions: ['x'.repeat(301)] }]) {
      expect(() => parseRequest(bad)).toThrow()
    }
  })
})

describe('permissions.request', () => {
  it('resolves true without asking when everything is held', async () => {
    const { call, ask } = setup()
    expect(await call('permissions.request', { permissions: ['storage'], origins: ['https://required.example/*'] }, false)).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('resolves true for a held request from a service worker, which cannot ask', async () => {
    const { handlers, event } = setup()
    expect(await (handlers.get('permissions.request') as Handler)(event('service-worker'), { permissions: ['storage'] }, false)).toBe(true)
  })

  it('refuses an undeclared permission and an undeclared origin before any prompt', async () => {
    const { call, ask } = setup()
    await expect(call('permissions.request', { permissions: ['downloads'] }, true)).rejects.toThrow(UNDECLARED_ERROR)
    await expect(call('permissions.request', { origins: ['https://other.example/*'] }, true)).rejects.toThrow(UNDECLARED_ERROR)
    expect(ask).not.toHaveBeenCalled()
  })

  it('refuses a name Orivon never grants, declared or not', async () => {
    const { call, ask } = setup()
    await expect(call('permissions.request', { permissions: ['webRequest'] }, true)).rejects.toThrow(NEVER_ERROR)
    expect(ask).not.toHaveBeenCalled()
  })

  it('refuses a call without a user gesture, and a service worker', async () => {
    const { call, handlers, event, ask } = setup()
    await expect(call('permissions.request', { permissions: ['history'] }, false)).rejects.toThrow(GESTURE_ERROR)
    await expect(call('permissions.request', { permissions: ['history'] })).rejects.toThrow(GESTURE_ERROR)
    await expect((handlers.get('permissions.request') as Handler)(event('service-worker'), { permissions: ['history'] }, true)).rejects.toThrow(GESTURE_ERROR)
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks with the extension\'s name, id and plain-word lines, in the window of the call', async () => {
    const { call, ask, window } = setup()
    await call('permissions.request', { permissions: ['history'], origins: ['https://a.example.com/*'] }, true)
    expect(ask).toHaveBeenCalledWith(window, 't1', {
      extensionId: ID,
      name: 'Tidy Tabs',
      icon: undefined,
      lines: [{ words: 'Read and change your browsing history' }, { words: 'Read and change your data on a.example.com' }]
    })
  })

  it('cuts a long name at forty characters', async () => {
    const { call, ask } = setup({ identity: async () => ({ name: 'N'.repeat(80), icon: undefined }) })
    await call('permissions.request', { permissions: ['history'] }, true)
    const shown = (ask.mock.calls[0] as unknown as [unknown, unknown, { name: string }])[2].name
    expect(shown).toHaveLength(40)
    expect(shown.endsWith('…')).toBe(true)
  })

  it('on Allow stores the grant, emits onAdded and applies the manifest quietly', async () => {
    const { call, prefs, sendEvent, applyManifest } = setup()
    expect(await call('permissions.request', { permissions: ['history'], origins: ['https://a.example.com/*'] }, true)).toBe(true)
    expect(prefs.get(ID).granted).toEqual({ permissions: ['history'], origins: ['https://a.example.com/*'] })
    expect(sendEvent).toHaveBeenCalledWith(ID, 'permissions.onAdded', { permissions: ['history'], origins: ['https://a.example.com/*'] })
    expect(applyManifest).toHaveBeenCalledWith(ID, 'quiet')
    expect(await call('permissions.contains', { permissions: ['history'] })).toBe(true)
  })

  it('on Deny stores nothing and resolves false', async () => {
    const { call, prefs, sendEvent } = setup({ ask: async () => false })
    expect(await call('permissions.request', { permissions: ['history'] }, true)).toBe(false)
    expect(prefs.get(ID).granted.permissions).toEqual([])
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('rejects a second request from the same extension while one is open', async () => {
    let answer: (allow: boolean) => void = () => {}
    const { call } = setup({ ask: async () => await new Promise<boolean>((resolve) => { answer = resolve }) })
    const first = call('permissions.request', { permissions: ['history'] }, true)
    await vi.waitFor(() => { expect(answer).not.toBe(undefined) })
    await expect(call('permissions.request', { permissions: ['bookmarks'] }, true)).rejects.toThrow(BUSY_ERROR)
    answer(false)
    expect(await first).toBe(false)
  })

  it('stops prompting an extension that was denied three times in a minute', async () => {
    const ask = vi.fn(async () => false)
    const { call } = setup({ ask })
    for (let i = 0; i < 3; i++) expect(await call('permissions.request', { permissions: ['history'] }, true)).toBe(false)
    await expect(call('permissions.request', { permissions: ['history'] }, true)).rejects.toThrow(NAGGING_ERROR)
    expect(ask).toHaveBeenCalledTimes(3)
  })

  it('rejects when there is no window to ask in', async () => {
    const { call } = setup({ target: () => undefined })
    await expect(call('permissions.request', { permissions: ['history'] }, true)).rejects.toThrow()
  })

  it('grants nothing when the extension went away during the prompt', async () => {
    const handlers = new Map<string, Handler>()
    const prefs = createExtensionPrefsStore(null)
    installPermissions({
      handle: (name: string, run: Handler) => { handlers.set(name, run) },
      sendEvent: vi.fn(),
      prefs,
      held: () => false,
      extensions: () => undefined,
      session: { extensions: { getExtension: () => null } }
    } as unknown as ExtensionApiContext, {
      target: () => ({ window: {} as never, tabId: 't' }), ask: async () => true, identity: async () => ({ name: 'x', icon: undefined }), nag: createNagLimit()
    })
    const event: ApiEvent = { type: 'frame', sender: undefined, extension: { id: ID, manifest: MANIFEST } }
    expect(await (handlers.get('permissions.request') as Handler)(event, { permissions: ['history'] }, true)).toBe(false)
    expect(prefs.get(ID).granted.permissions).toEqual([])
  })
})

describe('permissions.contains and getAll', () => {
  it('answer from the required items plus the grants', async () => {
    const { call, prefs } = setup()
    expect(await call('permissions.contains', { permissions: ['history'] })).toBe(false)
    expect(await call('permissions.contains', { permissions: ['storage'], origins: ['https://required.example/*'] })).toBe(true)
    prefs.update(ID, { granted: { permissions: ['history'], origins: ['https://a.example.com/*'] } })
    expect(await call('permissions.contains', { permissions: ['history'], origins: ['https://a.example.com/page/*'] })).toBe(true)
    expect(await call('permissions.contains', { origins: ['https://b.example.com/*'] })).toBe(false)
    expect(await call('permissions.getAll')).toEqual({
      permissions: ['storage', 'history'],
      origins: ['https://required.example/*', 'https://a.example.com/*']
    })
  })
})

describe('permissions.remove', () => {
  it('really removes a granted item, tells the extension and applies the manifest', async () => {
    const { call, prefs, sendEvent, applyManifest } = setup()
    prefs.update(ID, { granted: { permissions: ['history', 'bookmarks'], origins: [] } })
    expect(await call('permissions.remove', { permissions: ['history'] })).toBe(true)
    expect(prefs.get(ID).granted.permissions).toEqual(['bookmarks'])
    expect(sendEvent).toHaveBeenCalledWith(ID, 'permissions.onRemoved', { permissions: ['history'], origins: [] })
    expect(applyManifest).toHaveBeenCalledWith(ID, 'quiet')
    expect(await call('permissions.contains', { permissions: ['history'] })).toBe(false)
  })

  it('resolves false for a required permission and changes nothing', async () => {
    const { call, prefs, sendEvent } = setup()
    prefs.update(ID, { granted: { permissions: ['history'], origins: [] } })
    expect(await call('permissions.remove', { permissions: ['storage'] })).toBe(false)
    expect(await call('permissions.remove', { origins: ['https://required.example/*'] })).toBe(false)
    expect(prefs.get(ID).granted.permissions).toEqual(['history'])
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('resolves true and emits nothing for an item that was never granted', async () => {
    const { call, sendEvent } = setup()
    expect(await call('permissions.remove', { permissions: ['history'] })).toBe(true)
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('still sees a required item after its grant was merged into the loaded manifest', async () => {
    const merged = { ...MANIFEST, permissions: ['storage', 'history'] }
    const { call, prefs } = setup({}, merged)
    prefs.update(ID, { granted: { permissions: ['history'], origins: [] } })
    expect(await call('permissions.remove', { permissions: ['storage'] })).toBe(false)
    expect(await call('permissions.remove', { permissions: ['history'] })).toBe(true)
  })
})
