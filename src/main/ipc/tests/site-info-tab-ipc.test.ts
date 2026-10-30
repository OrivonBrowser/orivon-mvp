import { describe, expect, it, vi } from 'vitest'
import type { SiteInfoController } from '../../permissions/site-info-controller.js'
import type { SiteInfo } from '../../permissions/site-info.js'
import { SITE_INFO_COMMAND_CHANNEL } from '../../channels.js'
import { registerSiteInfoTabIpc } from '../site-info-tab-ipc.js'

// The tunnel popup opened for a tab: the tab is the one it was built for, never one a command names, and only the commands the
// tunnels page sends are answered.

const handlers = new Map<string, (event: unknown, command: unknown) => Promise<unknown>>()
const POPUP_URL = 'app://orivon/site-info/index.html'
const FRAME = { url: POPUP_URL }
const webContents = { mainFrame: FRAME, ipc: { handle: (channel: string, fn: (event: unknown, command: unknown) => Promise<unknown>) => { handlers.set(channel, fn) } } } as unknown as import('electron').WebContents
const OTHER_FRAME = { url: 'https://evil.test/' }
const TAB = 'tab-7'

const INFO = { origin: '', displayOrigin: 'This tab', tunnel: { subject: 'tab', via: null } } as unknown as SiteInfo
const NEXT = { ...INFO, tunnelKind: 'nym' } as unknown as SiteInfo

function fakeController (over: Partial<SiteInfoController> = {}): SiteInfoController {
  return {
    tabInfoFor: vi.fn(() => INFO),
    setTabTunnel: vi.fn(async () => true),
    setSiteAlways: vi.fn(async () => true),
    setBrowserTunnel: vi.fn(() => true),
    setNodesTunnel: vi.fn(() => true),
    setProxyAddress: vi.fn(() => 'ok' as const),
    testTunnel: vi.fn(async () => ({ ok: true as const, authentication: 'none' as const })),
    siteInfoFor: vi.fn(async () => { throw new Error('a tab popup never asks about an origin') }),
    setTunnel: vi.fn(async () => true),
    turnOn: vi.fn(async () => 'ok' as const),
    turnOff: vi.fn(async () => {}),
    revokePickedPath: vi.fn(async () => {}),
    deleteLocalFileData: vi.fn(async () => false),
    reviewPermissions: vi.fn(async () => true),
    applyUpdate: vi.fn(async () => ({ ok: true as const })),
    siteTrustFor: vi.fn(async () => null),
    storageDeclarationFor: vi.fn(async () => null),
    siteSummaryFor: vi.fn(async () => ({ asked: false, warning: false, missing: false })),
    inSession: vi.fn((info: SiteInfo) => info),
    withBrowserTunnel: vi.fn((info: SiteInfo) => info),
    ...over
  } as unknown as SiteInfoController
}

/** A controller whose info is `INFO` until `setTabTunnel` or `setSiteAlways` has run, and `NEXT` after: the answer must be read after the change, not before. */
function changing (over: Partial<SiteInfoController> = {}, answers = true): SiteInfoController {
  let changed = false
  return fakeController({
    tabInfoFor: vi.fn(async () => changed ? NEXT : INFO),
    setTabTunnel: vi.fn(async () => { changed = true; return answers }),
    setSiteAlways: vi.fn(async () => { changed = true; return answers }),
    ...over
  })
}

function register (controller: SiteInfoController): { openSettings: ReturnType<typeof vi.fn>, onContentHeight: ReturnType<typeof vi.fn>, closePopup: ReturnType<typeof vi.fn> } {
  const openSettings = vi.fn()
  const onContentHeight = vi.fn()
  const closePopup = vi.fn()
  registerSiteInfoTabIpc(webContents, POPUP_URL, controller, TAB, openSettings, onContentHeight, closePopup)
  return { openSettings, onContentHeight, closePopup }
}

async function dispatch (command: unknown, senderFrame: unknown = FRAME): Promise<unknown> {
  const fn = handlers.get(SITE_INFO_COMMAND_CHANNEL)
  if (fn === undefined) throw new Error('registerSiteInfoTabIpc did not register a handler')
  return await fn({ senderFrame }, command)
}

describe('registerSiteInfoTabIpc', () => {
  it('answers the info of the tab it was built for, whatever tab a command names', async () => {
    const controller = fakeController()
    register(controller)
    expect(await dispatch({ type: 'get', tab: 'tab-9', tabId: 'tab-9' })).toBe(INFO)
    expect(controller.tabInfoFor).toHaveBeenCalledWith(TAB)
    expect(controller.tabInfoFor).not.toHaveBeenCalledWith('tab-9')
  })

  it('adds the tunnel of the whole browser to every info it answers', async () => {
    const withBrowserTunnel = vi.fn((info: SiteInfo) => ({ ...info, everywhere: true }))
    register(fakeController({ withBrowserTunnel }))
    expect(await dispatch({ type: 'get' })).toEqual({ ...INFO, everywhere: true })
    expect(await dispatch({ type: 'setTunnel', kind: 'nym' })).toEqual({ ok: true, info: { ...INFO, everywhere: true } })
    expect(await dispatch({ type: 'setNodesTunnel', on: true })).toEqual({ ok: true, info: { ...INFO, everywhere: true } })
  })

  it('gives the tab the tunnel asked for, or none, and returns the info after', async () => {
    const controller = changing()
    register(controller)
    expect(await dispatch({ type: 'setTunnel', kind: 'nym', tab: 'tab-9' })).toEqual({ ok: true, info: NEXT })
    expect(controller.setTabTunnel).toHaveBeenCalledWith(TAB, 'nym', '')
    await dispatch({ type: 'setTunnel', kind: null })
    expect(controller.setTabTunnel).toHaveBeenLastCalledWith(TAB, null, '')
    expect(controller.setTunnel, 'a tab\'s switch never writes a website\'s entry').not.toHaveBeenCalled()
  })

  it('says it was not done, with the info as it was, when the controller could not', async () => {
    const controller = fakeController({ setTabTunnel: vi.fn(async () => false) })
    register(controller)
    expect(await dispatch({ type: 'setTunnel', kind: 'socks5' })).toEqual({ ok: false, info: INFO })
  })

  it('tells the controller which website the rows were drawn for, a string or nothing, and never lets the popup name the one that acts', async () => {
    const controller = fakeController()
    register(controller)
    await dispatch({ type: 'setTunnel', kind: 'nym', shownOrigin: 'https://news.example' })
    expect(controller.setTabTunnel).toHaveBeenLastCalledWith(TAB, 'nym', 'https://news.example')
    for (const shownOrigin of [7, null, {}, ['https://news.example']]) {
      await dispatch({ type: 'setTunnel', kind: 'socks5', shownOrigin })
      expect(controller.setTabTunnel, String(shownOrigin)).toHaveBeenLastCalledWith(TAB, 'socks5', '')
    }
  })

  it('answers with the info as it is after a move that was refused, so the rows show what is true', async () => {
    register(changing({}, false))
    expect(await dispatch({ type: 'setTunnel', kind: 'nym' })).toEqual({ ok: false, info: NEXT })
  })

  it('keeps or lets go of the website\'s own choice for the tab it was built for, whatever tab or origin a command names, and returns the info after', async () => {
    const controller = changing()
    register(controller)
    expect(await dispatch({ type: 'setSiteAlways', on: true, shownOrigin: 'https://news.example', tab: 'tab-9', origin: 'https://evil.example' })).toEqual({ ok: true, info: NEXT })
    expect(controller.setSiteAlways).toHaveBeenCalledWith(TAB, true, 'https://news.example')
    await dispatch({ type: 'setSiteAlways', on: false, shownOrigin: 'https://news.example' })
    expect(controller.setSiteAlways).toHaveBeenLastCalledWith(TAB, false, 'https://news.example')
    expect(controller.setTunnel, 'never an entry named by the popup').not.toHaveBeenCalled()
  })

  it('refuses a switch position that is no boolean, or a shown website that is no string, without reaching the controller', async () => {
    const controller = fakeController()
    register(controller)
    for (const on of [undefined, null, 1, 0, 'true', {}]) expect(await dispatch({ type: 'setSiteAlways', on, shownOrigin: 'https://news.example' }), String(on)).toEqual({ ok: false, info: INFO })
    for (const shownOrigin of [undefined, null, 7, {}, ['x']]) expect(await dispatch({ type: 'setSiteAlways', on: true, shownOrigin }), String(shownOrigin)).toEqual({ ok: false, info: INFO })
    expect(controller.setSiteAlways).not.toHaveBeenCalled()
  })

  it('says the switch did not move, with the info as it is, when the controller refused (a stale panel, a held window, settings that cannot be read)', async () => {
    register(fakeController({ setSiteAlways: vi.fn(async () => false) }))
    expect(await dispatch({ type: 'setSiteAlways', on: true, shownOrigin: 'https://news.example' })).toEqual({ ok: false, info: INFO })
  })

  it('carries out the commands that change the tab in the order they were sent, however long the info takes', async () => {
    let release: () => void = () => {}
    const slow = new Promise<void>((resolve) => { release = resolve })
    const controller = fakeController({ tabInfoFor: vi.fn(async () => { await slow; return INFO }) })
    register(controller)
    const sent = [
      dispatch({ type: 'setSiteAlways', on: true, shownOrigin: 'https://news.example' }),
      dispatch({ type: 'setSiteAlways', on: false, shownOrigin: 'https://news.example' }),
      dispatch({ type: 'setTunnel', kind: 'nym', shownOrigin: 'https://news.example' })
    ]
    expect(vi.mocked(controller.setSiteAlways).mock.calls.map((call) => call[1])).toEqual([true, false])
    expect(controller.setTabTunnel).toHaveBeenCalledTimes(1)
    release()
    await Promise.all(sent)
  })

  it('sizes and closes without waiting for the info of the tab', async () => {
    const controller = fakeController({ tabInfoFor: vi.fn(async () => { throw new Error('the info could not be built') }) })
    const { onContentHeight, closePopup } = register(controller)
    await dispatch({ type: 'contentHeight', height: 300 })
    await dispatch({ type: 'close' })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(onContentHeight).toHaveBeenCalledWith(300)
    expect(closePopup).toHaveBeenCalledTimes(1)
    expect(controller.tabInfoFor).not.toHaveBeenCalled()
  })

  it('answers nothing for the switch once the tab is gone', async () => {
    const gone = fakeController({ tabInfoFor: vi.fn(async () => undefined) })
    register(gone)
    expect(await dispatch({ type: 'setSiteAlways', on: true, shownOrigin: 'https://news.example' })).toBeUndefined()
    expect(gone.setSiteAlways).not.toHaveBeenCalled()
  })

  it('refuses a value that is not a tunnel without reaching the controller, and answers nothing once the tab is gone', async () => {
    const controller = fakeController()
    register(controller)
    for (const kind of [undefined, 1, 'true', true, 'tor', 'off', 'direct']) expect(await dispatch({ type: 'setTunnel', kind }), String(kind)).toEqual({ ok: false, info: INFO })
    expect(controller.setTabTunnel).not.toHaveBeenCalled()
    const gone = fakeController({ tabInfoFor: vi.fn(async () => undefined) })
    register(gone)
    expect(await dispatch({ type: 'setTunnel', kind: 'nym' })).toBeUndefined()
    expect(await dispatch({ type: 'get' })).toBeUndefined()
    expect(gone.setTabTunnel).not.toHaveBeenCalled()
  })

  it('sends the whole browser through the tunnel asked for, or through none, and returns the tab\'s info after', async () => {
    const tabInfoFor = vi.fn().mockReturnValueOnce(INFO).mockReturnValue(NEXT)
    const controller = fakeController({ tabInfoFor })
    register(controller)
    expect(await dispatch({ type: 'setBrowserTunnel', kind: 'socks5', tab: 'tab-9' })).toEqual({ ok: true, info: NEXT })
    expect(controller.setBrowserTunnel).toHaveBeenCalledWith('socks5')
    await dispatch({ type: 'setBrowserTunnel', kind: null })
    expect(controller.setBrowserTunnel).toHaveBeenLastCalledWith(null)
    expect(controller.setTabTunnel, 'the browser-wide switch never moves the tab\'s own choice').not.toHaveBeenCalled()
  })

  it('says the browser was not moved, with the info as it was, when the controller could not', async () => {
    const controller = fakeController({ setBrowserTunnel: vi.fn(() => false) })
    register(controller)
    expect(await dispatch({ type: 'setBrowserTunnel', kind: 'nym' })).toEqual({ ok: false, info: INFO })
  })

  it('refuses a browser-wide value that is not a tunnel without reaching the controller', async () => {
    const controller = fakeController()
    register(controller)
    for (const kind of [undefined, 1, 'true', true, false, 'tor', 'off', 'direct']) expect(await dispatch({ type: 'setBrowserTunnel', kind }), String(kind)).toEqual({ ok: false, info: INFO })
    expect(controller.setBrowserTunnel).not.toHaveBeenCalled()
  })

  it('sets whether the nodes follow the tunnel only for a true or a false, and returns the info after', async () => {
    const tabInfoFor = vi.fn().mockReturnValueOnce(INFO).mockReturnValue(NEXT)
    const controller = fakeController({ tabInfoFor })
    register(controller)
    expect(await dispatch({ type: 'setNodesTunnel', on: true })).toEqual({ ok: true, info: NEXT })
    expect(controller.setNodesTunnel).toHaveBeenCalledWith(true)
    await dispatch({ type: 'setNodesTunnel', on: false })
    expect(controller.setNodesTunnel).toHaveBeenLastCalledWith(false)
    expect(controller.setNodesTunnel).toHaveBeenCalledTimes(2)
    const strict = fakeController()
    register(strict)
    for (const on of [undefined, null, 1, 0, 'true', 'on', {}, []]) expect(await dispatch({ type: 'setNodesTunnel', on }), String(on)).toEqual({ ok: false, info: INFO })
    expect(strict.setNodesTunnel).not.toHaveBeenCalled()
    const refusing = fakeController({ setNodesTunnel: vi.fn(() => false) })
    register(refusing)
    expect(await dispatch({ type: 'setNodesTunnel', on: true })).toEqual({ ok: false, info: INFO })
  })

  it('answers nothing for the browser-wide commands once the tab is gone', async () => {
    const gone = fakeController({ tabInfoFor: vi.fn(async () => undefined) })
    register(gone)
    expect(await dispatch({ type: 'setBrowserTunnel', kind: 'nym' })).toBeUndefined()
    expect(await dispatch({ type: 'setNodesTunnel', on: true })).toBeUndefined()
    expect(gone.setBrowserTunnel).not.toHaveBeenCalled()
    expect(gone.setNodesTunnel).not.toHaveBeenCalled()
  })

  it('saves the proxy\'s address, and tests a tunnel naming no address', async () => {
    const controller = fakeController()
    register(controller)
    expect(await dispatch({ type: 'setProxyAddress', text: '127.0.0.1:9150' })).toEqual({ ok: true, info: INFO })
    expect(controller.setProxyAddress).toHaveBeenCalledWith('127.0.0.1:9150')
    expect(await dispatch({ type: 'setProxyAddress', text: 7 })).toEqual({ ok: false, reason: 'invalid', info: INFO })
    expect(await dispatch({ type: 'testTunnel', kind: 'socks5', address: '10.0.0.1:1' })).toEqual({ ok: true, authentication: 'none' })
    expect(controller.testTunnel).toHaveBeenCalledWith('socks5')
    expect(await dispatch({ type: 'testTunnel', kind: 'tor' })).toBeNull()
  })

  it('leads to Settings > Tunnels, sizes itself and closes', async () => {
    const { openSettings, onContentHeight, closePopup } = register(fakeController())
    await dispatch({ type: 'openTunnelSettings', everywhere: true })
    await dispatch({ type: 'openTunnelSettings', everywhere: false })
    expect(openSettings.mock.calls).toEqual([['/tunnels#route-everywhere'], ['/tunnels']])
    await dispatch({ type: 'contentHeight', height: 300 })
    await dispatch({ type: 'contentHeight', height: Number.NaN })
    expect(onContentHeight.mock.calls).toEqual([[300]])
    await dispatch({ type: 'close' })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(closePopup).toHaveBeenCalledTimes(1)
  })

  it('answers none of what a site\'s popup answers: capabilities, cookies, data, the Web3 Score, the update offer', async () => {
    const controller = fakeController()
    register(controller)
    for (const command of [
      { type: 'trust' }, { type: 'data' }, { type: 'apply', changes: [{ capability: 'fs', on: true, shownPatterns: [] }] }, { type: 'sitePermissions' },
      { type: 'setSitePermission', kind: 'camera', value: 'allow' }, { type: 'revokePickedPath', pickId: 'p' }, { type: 'applyUpdate', cid: 'c' },
      { type: 'clearBrowserData' }, { type: 'removeCookie', key: 'k' }, { type: 'clearCookies' }, { type: 'reload' }, { type: 'deleteLocalFile' },
      { type: 'reviewPermissions' }, { type: 'openSiteSettings' }, { type: 'openExtensions' }, { type: 'certificate' }, { type: 'openScoreHelp' }, { type: 'openHome' }, { type: 'openSupport' }
    ]) expect(await dispatch(command), command.type).toBeUndefined()
    expect(controller.turnOn).not.toHaveBeenCalled()
    expect(controller.revokePickedPath).not.toHaveBeenCalled()
    expect(controller.deleteLocalFileData).not.toHaveBeenCalled()
    expect(controller.siteTrustFor).not.toHaveBeenCalled()
    expect(controller.siteInfoFor).not.toHaveBeenCalled()
  })

  it('answers nothing from another frame', async () => {
    const controller = fakeController()
    register(controller)
    for (const command of [{ type: 'get' }, { type: 'setTunnel', kind: 'nym' }, { type: 'setSiteAlways', on: true, shownOrigin: 'https://news.example' }, { type: 'setBrowserTunnel', kind: 'nym' }, { type: 'setNodesTunnel', on: true }, { type: 'setProxyAddress', text: '127.0.0.1:9050' }, { type: 'testTunnel', kind: 'nym' }]) {
      expect(await dispatch(command, OTHER_FRAME), command.type).toBeUndefined()
    }
    expect(controller.setTabTunnel).not.toHaveBeenCalled()
    expect(controller.setBrowserTunnel).not.toHaveBeenCalled()
    expect(controller.setNodesTunnel).not.toHaveBeenCalled()
    expect(controller.setProxyAddress).not.toHaveBeenCalled()
    expect(controller.testTunnel).not.toHaveBeenCalled()
  })
})
