import { describe, expect, it } from 'vitest'
import { createSidePanelOptions, panelUrl, parseOptionsInput } from '../side-panel-options.js'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'

function make (manifest: unknown = { side_panel: { default_path: 'panel.html' } }, holds = true) {
  return createSidePanelOptions({ manifestOf: () => manifest, holds: () => holds })
}

describe('panelUrl', () => {
  it('resolves a path inside the extension, absolute or relative', () => {
    expect(panelUrl(ID, 'panel.html')).toBe(`chrome-extension://${ID}/panel.html`)
    expect(panelUrl(ID, '/ui/panel.html?x=1#a')).toBe(`chrome-extension://${ID}/ui/panel.html?x=1#a`)
    expect(panelUrl(ID, '../../panel.html')).toBe(`chrome-extension://${ID}/panel.html`)
  })

  it.each([
    ['an https address', 'https://example.com/panel.html'],
    ['a protocol-relative address', '//example.com/panel.html'],
    ['a javascript address', 'javascript:alert(1)'],
    ['a data address', 'data:text/html,hi'],
    ['another extension', `chrome-extension://${OTHER}/panel.html`]
  ])('refuses %s', (_name, path) => {
    expect(panelUrl(ID, path)).toBeUndefined()
  })
})

describe('parseOptionsInput', () => {
  it('takes an object with an integer tab, a string path and a boolean flag', () => {
    expect(parseOptionsInput({ tabId: 3, path: 'a.html', enabled: false })).toEqual({ tabId: 3, path: 'a.html', enabled: false })
    expect(parseOptionsInput({})).toEqual({ tabId: undefined, path: undefined, enabled: undefined })
  })

  it.each([[null], [[]], ['x'], [{ tabId: 1.5 }], [{ tabId: '1' }], [{ path: 1 }], [{ path: ' ' }], [{ enabled: 'yes' }]])('rejects %j', (raw) => {
    expect(() => parseOptionsInput(raw)).toThrow(/sidePanel|Invalid value/)
  })
})

describe('the options an extension set', () => {
  it('shows the manifest default path, and nothing without one', () => {
    expect(make().get(ID)).toEqual({ enabled: true, path: 'panel.html' })
    expect(make({}).get(ID)).toEqual({ enabled: false })
    expect(make().panelFor(ID)).toBe(`chrome-extension://${ID}/panel.html`)
    expect(make({}).panelFor(ID)).toBeUndefined()
  })

  it('shows no panel to an extension that does not hold the permission', () => {
    expect(make(undefined, false).panelFor(ID)).toBeUndefined()
    expect(make({ side_panel: { default_path: 'p.html' } }, false).panelFor(ID)).toBeUndefined()
  })

  it('lets a global setting replace the default, and a tab setting replace the global one', () => {
    const options = make()
    options.set(ID, { path: 'global.html' })
    expect(options.panelFor(ID)).toBe(`chrome-extension://${ID}/global.html`)
    options.set(ID, { tabId: 7, path: 'tab.html' })
    expect(options.panelFor(ID, 7)).toBe(`chrome-extension://${ID}/tab.html`)
    expect(options.panelFor(ID, 8)).toBe(`chrome-extension://${ID}/global.html`)
    expect(options.panelFor(ID)).toBe(`chrome-extension://${ID}/global.html`)
  })

  it('treats enabled as true unless set, per tab and globally', () => {
    const options = make()
    options.set(ID, { tabId: 7, enabled: false })
    expect(options.panelFor(ID, 7)).toBeUndefined()
    expect(options.panelFor(ID, 8)).toBeDefined()
    options.set(ID, { tabId: 7, enabled: true })
    expect(options.panelFor(ID, 7)).toBeDefined()
    options.set(ID, { enabled: false })
    expect(options.panelFor(ID, 8)).toBeUndefined()
    expect(options.panelFor(ID, 7)).toBeDefined()
  })

  it('refuses an address outside the extension even when one was stored', () => {
    const options = make()
    options.set(ID, { path: 'https://example.com/' })
    expect(options.panelFor(ID)).toBeUndefined()
  })

  it('forgets a closed tab, and everything of an unloaded extension', () => {
    const options = make()
    options.set(ID, { tabId: 7, path: 'tab.html' })
    options.setOpenOnActionClick(ID, true)
    expect(options.hasTabOptions(ID, 7)).toBe(true)
    expect(options.tabsOf(ID)).toEqual([7])
    options.forgetTab(7)
    expect(options.hasTabOptions(ID, 7)).toBe(false)
    options.forget(ID)
    expect(options.openOnActionClick(ID)).toBe(false)
  })

  it('keeps the toolbar behaviour per extension, off by default', () => {
    const options = make()
    expect(options.openOnActionClick(ID)).toBe(false)
    options.setOpenOnActionClick(ID, true)
    expect(options.openOnActionClick(ID)).toBe(true)
    expect(options.openOnActionClick(OTHER)).toBe(false)
  })
})
