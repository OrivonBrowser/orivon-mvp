import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TabState } from '../../main/shell/tabs.js'
import type { ChromeContext } from '../chrome/context.js'
import { CHROME_MODULES } from '../chrome/modules.js'
import { TUNNEL_BUTTON_LABEL, TUNNEL_NOTES, createTunnelButton, tunnelButtonLook } from '../chrome/tunnel-button.js'

afterEach(() => { vi.unstubAllGlobals() })

const site = { url: 'https://example.com/', isNewTab: false, isInternal: false } as TabState
const newTab = { url: '', isNewTab: true, isInternal: false } as TabState
const internal = { url: 'orivon://settings/', isNewTab: false, isInternal: true } as TabState

describe('the tunnel button look', () => {
  it('is absent on the new tab, a shell page and with no tab', () => {
    for (const tab of [newTab, internal, undefined]) expect(tunnelButtonLook(tab, 'on').hidden).toBe(true)
  })

  it('is the plain colour on a direct page and says only its name', () => {
    expect(tunnelButtonLook(site, null)).toEqual({ hidden: false, state: null, label: TUNNEL_BUTTON_LABEL })
  })

  it('is on for a tunnelled page and down when the tunnel does not answer, and says so', () => {
    expect(tunnelButtonLook(site, 'on')).toEqual({ hidden: false, state: 'on', label: `Tunnels. ${TUNNEL_NOTES.on}` })
    expect(tunnelButtonLook(site, 'down')).toEqual({ hidden: false, state: 'down', label: `Tunnels. ${TUNNEL_NOTES.down}` })
  })
})

function mount (active: TabState | undefined) {
  const attrs = new Map<string, string>()
  const listeners = new Map<string, (event: { button: number }) => void>()
  const button = {
    hidden: true,
    title: '',
    setAttribute: (name: string, value: string) => { attrs.set(name, value) },
    removeAttribute: (name: string) => { attrs.delete(name) },
    addEventListener: (type: string, listener: (event: { button: number }) => void) => { listeners.set(type, listener) }
  }
  vi.stubGlobal('document', { querySelector: (selector: string) => selector === '#tunnel-btn' ? button : null })
  const shell = { press: vi.fn(), openSiteInfo: vi.fn() }
  const ctx = { shell, activeTab: () => active, anchorFor: () => ({ x: 1, y: 2, width: 3, height: 4 }) } as unknown as ChromeContext
  const module = createTunnelButton()
  module.init(ctx)
  return { button, attrs, shell, ctx, render: (tunnel: 'on' | 'down' | null) => { module.render?.({ tunnel } as never, ctx) }, listeners }
}

describe('the tunnel button module', () => {
  it('is one of the chrome modules', () => {
    expect(CHROME_MODULES.map((module) => module.name)).toContain('tunnel-button')
  })

  it('draws the page\'s state on its own attribute and label, and clears it', () => {
    const { button, attrs, render } = mount(site)
    render('on')
    expect(button.hidden).toBe(false)
    expect(attrs.get('data-tunnel')).toBe('on')
    expect(attrs.get('aria-label')).toBe(`Tunnels. ${TUNNEL_NOTES.on}`)
    render(null)
    expect(attrs.has('data-tunnel')).toBe(false)
    expect(button.title).toBe(TUNNEL_BUTTON_LABEL)
  })

  it('opens the tunnels page under itself for the page in front, and notes the press first', () => {
    const { shell, listeners } = mount(site)
    listeners.get('pointerdown')?.({ button: 0 })
    expect(shell.press).toHaveBeenCalledWith('tunnels')
    listeners.get('click')?.({ button: 0 })
    expect(shell.openSiteInfo).toHaveBeenCalledWith({ x: 1, y: 2, width: 3, height: 4 }, 'tunnels', 'https://example.com/')
  })

  it('opens nothing for a page with no site, and ignores a right press', () => {
    const { shell, listeners } = mount(newTab)
    listeners.get('click')?.({ button: 0 })
    listeners.get('pointerdown')?.({ button: 2 })
    expect(shell.openSiteInfo).not.toHaveBeenCalled()
    expect(shell.press).not.toHaveBeenCalled()
  })
})
