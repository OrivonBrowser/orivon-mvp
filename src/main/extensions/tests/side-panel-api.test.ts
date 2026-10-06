import { describe, expect, it, vi } from 'vitest'
import { fakeContext, EXT } from '../api/tests/api-fixtures.js'
import { createSidePanelApi, GESTURE_ERROR, TARGET_ERROR } from '../side-panel-api.js'
import type { SidePanelDriver } from '../side-panel-api.js'
import { createGestureLedger } from '../side-panel-gesture.js'
import { createSidePanelOptions } from '../side-panel-options.js'

function setup (opts: { appTab?: boolean, internal?: boolean, refuse?: string } = {}) {
  const window = { window: { id: 5, isDestroyed: () => false } }
  const contents = { getURL: () => (opts.appTab === true ? 'https://app.example/x' : 'https://page.test/') }
  const shell = {
    windows: { all: () => [window] },
    internalPages: { pageOf: () => (opts.internal === true ? 'settings' : undefined) }
  }
  const found = { contents, window, id: 't1' }
  const options = createSidePanelOptions({ manifestOf: () => ({ side_panel: { default_path: 'panel.html' } }), holds: () => true })
  const gesture = createGestureLedger()
  const driver = {
    options, gesture, side: () => 'left',
    optionsChanged: vi.fn(), behaviorChanged: vi.fn(),
    open: vi.fn(async () => { if (opts.refuse !== undefined) throw new Error(opts.refuse) }),
    close: vi.fn(async () => {})
  } satisfies SidePanelDriver
  const fake = fakeContext(shell, { tab: ((id: unknown) => (id === 42 ? found : undefined)) as never })
  createSidePanelApi(() => driver).install(fake.ctx)
  return { driver, window, ...fake }
}

describe('the sidePanel module', () => {
  it('is gated on the sidePanel permission', () => {
    expect(createSidePanelApi(() => ({}) as never)).toMatchObject({ name: 'sidePanel', permission: 'sidePanel' })
  })
})

describe('sidePanel.open', () => {
  it('rejects without a user gesture, with the message extensions look for', async () => {
    const s = setup()
    await expect(s.call('sidePanel.open', { windowId: 5 })).rejects.toThrow(GESTURE_ERROR)
    expect(s.driver.open).not.toHaveBeenCalled()
  })

  it('opens through the driver after a gesture, and spends it', async () => {
    const s = setup()
    s.driver.gesture.record(EXT)
    await s.call('sidePanel.open', { windowId: 5 })
    expect(s.driver.open).toHaveBeenCalledWith({ extensionId: EXT, window: s.window, tabId: undefined })
    await expect(s.call('sidePanel.open', { windowId: 5 })).rejects.toThrow(GESTURE_ERROR)
  })

  it('names the tab the call gave', async () => {
    const s = setup()
    s.driver.gesture.record(EXT)
    await s.call('sidePanel.open', { tabId: 42 })
    expect(s.driver.open).toHaveBeenCalledWith({ extensionId: EXT, window: s.window, tabId: 42 })
  })

  it('needs a window or a tab, and one that exists', async () => {
    const s = setup()
    s.driver.gesture.record(EXT)
    await expect(s.call('sidePanel.open', {})).rejects.toThrow(TARGET_ERROR)
    await expect(s.call('sidePanel.open')).rejects.toThrow(TARGET_ERROR)
    await expect(s.call('sidePanel.open', { windowId: 99 })).rejects.toThrow('No window with id: 99.')
    await expect(s.call('sidePanel.open', { tabId: 7 })).rejects.toThrow('No tab with id: 7.')
  })

  it('passes on the driver\'s refusal and keeps the gesture for a try that can work', async () => {
    const s = setup({ refuse: 'No active side panel for windowId: 5.' })
    s.driver.gesture.record(EXT)
    await expect(s.call('sidePanel.open', { windowId: 5 })).rejects.toThrow('No active side panel for windowId: 5.')
    expect(s.driver.gesture.available(EXT)).toBe(true)
  })
})

describe('an app\'s tab and an Orivon page', () => {
  it.each([[{ appTab: true }], [{ internal: true }]])('is no tab in open, setOptions and getOptions (%j)', async (opts) => {
    const s = setup(opts)
    s.driver.gesture.record(EXT)
    await expect(s.call('sidePanel.open', { tabId: 42 })).rejects.toThrow('No tab with id: 42.')
    await expect(s.call('sidePanel.setOptions', { tabId: 42, enabled: false })).rejects.toThrow('No tab with id: 42.')
    await expect(s.call('sidePanel.getOptions', { tabId: 42 })).rejects.toThrow('No tab with id: 42.')
  })
})

describe('sidePanel.setOptions and getOptions', () => {
  it('stores what was set and tells the driver', async () => {
    const s = setup()
    await s.call('sidePanel.setOptions', { path: 'other.html' })
    await s.call('sidePanel.setOptions', { tabId: 42, enabled: false })
    expect(s.driver.optionsChanged).toHaveBeenCalledTimes(2)
    expect(await s.call('sidePanel.getOptions', {})).toEqual({ enabled: true, path: 'other.html' })
    expect(await s.call('sidePanel.getOptions', { tabId: 42 })).toEqual({ enabled: false, path: 'other.html' })
  })

  it.each([['https://example.com/p.html'], ['//example.com/p.html'], ['javascript:alert(1)'], ['chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/p.html']])('rejects the path %s', async (path) => {
    const s = setup()
    await expect(s.call('sidePanel.setOptions', { path })).rejects.toThrow(/Property 'path'/)
    expect(s.driver.optionsChanged).not.toHaveBeenCalled()
  })

  it('rejects a malformed argument', async () => {
    const s = setup()
    await expect(s.call('sidePanel.setOptions', 'x')).rejects.toThrow(/must be an object/)
    await expect(s.call('sidePanel.setOptions', { enabled: 1 })).rejects.toThrow(/Expected boolean/)
  })
})

describe('behaviour and layout', () => {
  it('keeps the toolbar behaviour and tells the driver to save it', async () => {
    const s = setup()
    expect(await s.call('sidePanel.getPanelBehavior')).toEqual({ openPanelOnActionClick: false })
    await s.call('sidePanel.setPanelBehavior', { openPanelOnActionClick: true })
    expect(await s.call('sidePanel.getPanelBehavior')).toEqual({ openPanelOnActionClick: true })
    expect(s.driver.behaviorChanged).toHaveBeenCalledWith(EXT)
    await expect(s.call('sidePanel.setPanelBehavior', { openPanelOnActionClick: 'yes' })).rejects.toThrow(/Expected boolean/)
  })

  it('answers the side the panel sits on', async () => {
    expect(await setup().call('sidePanel.getLayout')).toEqual({ side: 'left' })
  })

  it('closes through the driver, with no gesture', async () => {
    const s = setup()
    await s.call('sidePanel.close', { windowId: 5 })
    expect(s.driver.close).toHaveBeenCalledWith({ extensionId: EXT, window: s.window, tabId: undefined })
  })
})
