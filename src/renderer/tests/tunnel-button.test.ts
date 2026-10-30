import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TabState } from '../../main/shell/tabs.js'
import type { ChromeContext } from '../chrome/context.js'
import { CHROME_MODULES } from '../chrome/modules.js'
import { TAB_CHOICE_NOTE, TAB_TUNNEL_NOTES, TUNNEL_BUTTON_LABEL, TUNNEL_NOTES, createTunnelButton, tunnelButtonLook } from '../chrome/tunnel-button.js'

afterEach(() => { vi.unstubAllGlobals() })

const site = { url: 'https://example.com/', isNewTab: false, isInternal: false } as TabState
const newTab = { url: '', isNewTab: true, isInternal: false } as TabState
const internal = { url: 'orivon://settings/', isNewTab: false, isInternal: true } as TabState

describe('the tunnel button look', () => {
  it('is absent on a shell page and with no tab, and there on the new tab', () => {
    for (const tab of [internal, undefined]) expect(tunnelButtonLook(tab, 'on').hidden).toBe(true)
    expect(tunnelButtonLook(newTab, null).hidden).toBe(false)
  })

  it('is the plain colour on a direct page and says only its name', () => {
    expect(tunnelButtonLook(site, null)).toEqual({ hidden: false, state: null, label: TUNNEL_BUTTON_LABEL })
  })

  it('is on for a tunnelled page and down when the tunnel does not answer, and says so', () => {
    expect(tunnelButtonLook(site, 'on')).toEqual({ hidden: false, state: 'on', label: `Tunnels. ${TUNNEL_NOTES.on}` })
    expect(tunnelButtonLook(site, 'down')).toEqual({ hidden: false, state: 'down', label: `Tunnels. ${TUNNEL_NOTES.down}` })
  })

  it('names the tunnel the page goes through, and the one that is not answering', () => {
    expect(tunnelButtonLook(site, 'on', 'nym').label).toBe('Tunnels. This page goes through Nym')
    expect(tunnelButtonLook(site, 'on', 'socks5').label).toBe('Tunnels. This page goes through your proxy')
    expect(tunnelButtonLook(site, 'down', 'nym').label).toBe('Tunnels. Nym is not answering, so this page\'s traffic is stopped')
    expect(tunnelButtonLook(site, 'down', 'socks5').label).toBe('Tunnels. Your proxy is not answering, so this page\'s traffic is stopped')
    expect(tunnelButtonLook(site, null, 'nym').label, 'a direct page names no tunnel').toBe(TUNNEL_BUTTON_LABEL)
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
  return { button, attrs, shell, ctx, render: (tunnel: 'on' | 'down' | null, tunnelVia: 'nym' | 'socks5' | null = null, tunnelByTab = false) => { module.render?.({ tunnel, tunnelVia, tunnelByTab } as never, ctx) }, listeners }
}

describe('the tunnel button look on a new tab', () => {
  it('is the plain colour and says only its name while the tab\'s sites will go direct', () => {
    expect(tunnelButtonLook(newTab, null)).toEqual({ hidden: false, state: null, label: TUNNEL_BUTTON_LABEL })
  })

  it('says a direct tab\'s sites go direct, which a tab with no choice has no need to say', () => {
    expect(tunnelButtonLook({ ...newTab, tunnelChoice: 'direct' }, null).label).toBe(`Tunnels. ${TAB_TUNNEL_NOTES.direct}`)
    expect(tunnelButtonLook({ ...newTab, tunnelChoice: 'nym' }, null).label, 'the tunnel is not answering as a plain tab would say').toBe(TUNNEL_BUTTON_LABEL)
  })

  it('is on when the tab\'s sites will go through a tunnel, and names Nym but not the person\'s own tunnel', () => {
    expect(tunnelButtonLook(newTab, 'on', 'nym')).toEqual({ hidden: false, state: 'on', label: 'Tunnels. Sites you open in this tab go through Nym' })
    expect(tunnelButtonLook(newTab, 'on', 'socks5').label).toBe('Tunnels. Sites you open in this tab go through your tunnel')
    expect(tunnelButtonLook(newTab, 'on').label).toBe(`Tunnels. ${TAB_TUNNEL_NOTES.on}`)
  })

  it('is down when the tunnel does not answer, and says the tab\'s traffic is stopped', () => {
    expect(tunnelButtonLook(newTab, 'down', 'nym')).toEqual({ hidden: false, state: 'down', label: 'Tunnels. Nym is not answering, so this tab\'s traffic is stopped' })
    expect(tunnelButtonLook(newTab, 'down', 'socks5').label).toBe('Tunnels. Your tunnel is not answering, so this tab\'s traffic is stopped')
  })

  it('does not call a website\'s words a tab\'s: a website in a tab with a choice is the page\'s state, and says the choice is the tab\'s', () => {
    expect(tunnelButtonLook({ ...site, tunnelChoice: 'nym' }, 'on', 'nym', true).label).toBe(`Tunnels. This page goes through Nym. ${TAB_CHOICE_NOTE}`)
    expect(tunnelButtonLook({ ...site, tunnelChoice: 'nym' }, 'down', 'nym', true).label).toBe(`Tunnels. Nym is not answering, so this page's traffic is stopped. ${TAB_CHOICE_NOTE}`)
    expect(tunnelButtonLook({ ...site, tunnelChoice: 'direct' }, null, null, true).label).toBe(`Tunnels. ${TAB_TUNNEL_NOTES.direct}`)
    expect(tunnelButtonLook(site, 'on', 'nym').label, 'a tab with no choice says nothing of the tab').toBe('Tunnels. This page goes through Nym')
  })
})

describe('the tunnel button look on a website, which the button opens the tab\'s list for whatever the tab carries (ADR-0104)', () => {
  it('says nothing of the tab for a website that has a tunnel of its own and a tab with no choice, which sets nothing for the tab', () => {
    for (const via of ['nym', 'socks5'] as const) {
      expect(tunnelButtonLook(site, 'on', via, true).label, via).not.toContain(TAB_CHOICE_NOTE)
      expect(tunnelButtonLook(site, 'down', via, true).label, via).not.toContain(TAB_CHOICE_NOTE)
    }
    expect(tunnelButtonLook(site, 'on', 'nym', true).label).toBe('Tunnels. This page goes through Nym')
  })

  it('says nothing of the tab for a website that follows the browser, on a tunnel or direct', () => {
    expect(tunnelButtonLook(site, 'on', 'socks5', true).label).toBe('Tunnels. This page goes through your proxy')
    expect(tunnelButtonLook(site, null, null, true).label).toBe(TUNNEL_BUTTON_LABEL)
  })

  it('says a direct tab\'s sites go direct only while the page does, and not for a website that keeps its own tunnel in a direct tab', () => {
    expect(tunnelButtonLook({ ...site, tunnelChoice: 'direct' }, null, null, true).label).toBe(`Tunnels. ${TAB_TUNNEL_NOTES.direct}`)
    expect(tunnelButtonLook({ ...site, tunnelChoice: 'direct' }, 'on', 'nym', true).label).toBe('Tunnels. This page goes through Nym')
  })

  it('says the choice is the tab\'s for a website with an entry of its own while its tab carries the same tunnel: the tab does hold it', () => {
    expect(tunnelButtonLook({ ...site, tunnelChoice: 'nym' }, 'on', 'nym', true).label).toBe(`Tunnels. This page goes through Nym. ${TAB_CHOICE_NOTE}`)
  })
})

describe('the tunnel button look when the page is not on the tunnel its tab chose', () => {
  it('does not say the choice is the tab\'s for a page on a tunnel of its own in a direct tab, which a direct choice leaves it', () => {
    expect(tunnelButtonLook({ ...site, tunnelChoice: 'direct' }, 'on', 'socks5', true).label).toBe('Tunnels. This page goes through your proxy')
    expect(tunnelButtonLook({ ...site, tunnelChoice: 'direct' }, 'down', 'nym', true).label).toBe('Tunnels. Nym is not answering, so this page\'s traffic is stopped')
  })

  it('does not say it for a page on the other tunnel than the tab\'s, as a page an app opened is', () => {
    expect(tunnelButtonLook({ ...site, tunnelChoice: 'nym' }, 'on', 'socks5', true).label).toBe('Tunnels. This page goes through your proxy')
  })

  it('says it only when the page is on the tunnel the tab chose', () => {
    expect(tunnelButtonLook({ ...site, tunnelChoice: 'socks5' }, 'on', 'socks5', true).label).toBe(`Tunnels. This page goes through your proxy. ${TAB_CHOICE_NOTE}`)
    expect(tunnelButtonLook({ ...site, tunnelChoice: 'nym' }, 'on', 'nym', true).label).toBe(`Tunnels. This page goes through Nym. ${TAB_CHOICE_NOTE}`)
  })
})

describe('the tunnel button look when the button is not about the tab', () => {
  // An installed app, or a page in a session an app or a temporary route made for it, keeps its own tunnel whatever its tab carries, and the
  // button opens that page's list: main says so with tunnelByTab false, and the tab's words would promise a setting the click does not open.
  it('does not say the choice is the tab\'s for a page on the tunnel the tab chose, when that tunnel is the page\'s own', () => {
    for (const via of ['nym', 'socks5'] as const) {
      expect(tunnelButtonLook({ ...site, tunnelChoice: via }, 'on', via, false).label, via).not.toContain(TAB_CHOICE_NOTE)
      expect(tunnelButtonLook({ ...site, tunnelChoice: via }, 'down', via, false).label, via).not.toContain(TAB_CHOICE_NOTE)
    }
    expect(tunnelButtonLook({ ...site, tunnelChoice: 'nym' }, 'on', 'nym', false).label).toBe('Tunnels. This page goes through Nym')
  })

  it('does not say a direct tab\'s sites go direct for a page that goes direct by itself', () => {
    expect(tunnelButtonLook({ ...site, tunnelChoice: 'direct' }, null, null, false).label).toBe(TUNNEL_BUTTON_LABEL)
  })

  it('is told by the state main pushes, not read from the tab: the module draws the suffix only with tunnelByTab', () => {
    const { attrs, render } = mount({ ...site, tunnelChoice: 'nym' })
    render('on', 'nym', true)
    expect(attrs.get('aria-label')).toBe(`Tunnels. This page goes through Nym. ${TAB_CHOICE_NOTE}`)
    render('on', 'nym', false)
    expect(attrs.get('aria-label')).toBe('Tunnels. This page goes through Nym')
  })
})

describe('the tunnel button on a blank page that is no new tab', () => {
  const popup = { url: 'about:blank', isNewTab: true, isInternal: false, blankPage: true } as TabState

  it('is absent: a blank page in a tab that is not the dashboard\'s has no button in whatever session, as its opener writes into it', () => {
    expect(tunnelButtonLook(popup, 'on', 'nym').hidden).toBe(true)
    expect(tunnelButtonLook({ ...popup, tunnelChoice: 'nym' }, null).hidden).toBe(true)
  })

  it('opens nothing when pressed', () => {
    const { shell, listeners } = mount(popup)
    listeners.get('click')?.({ button: 0 })
    expect(shell.openSiteInfo).not.toHaveBeenCalled()
  })

  it('is still there on a new tab', () => {
    expect(tunnelButtonLook(newTab, null).hidden).toBe(false)
  })
})

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
    render('on', 'nym')
    expect(attrs.get('aria-label')).toBe('Tunnels. This page goes through Nym')
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

  it('opens the tunnels page for the new tab with no address, for there is none', () => {
    const { shell, listeners } = mount(newTab)
    listeners.get('click')?.({ button: 0 })
    expect(shell.openSiteInfo).toHaveBeenCalledExactlyOnceWith({ x: 1, y: 2, width: 3, height: 4 }, 'tunnels')
  })

  it('draws a new tab\'s state in the words of the tab', () => {
    const { button, attrs, render } = mount(newTab)
    render('on', 'nym')
    expect(button.hidden).toBe(false)
    expect(attrs.get('data-tunnel')).toBe('on')
    expect(attrs.get('aria-label')).toBe('Tunnels. Sites you open in this tab go through Nym')
  })

  it('opens nothing on a shell page, and ignores a right press', () => {
    const { shell, listeners } = mount(internal)
    listeners.get('click')?.({ button: 0 })
    listeners.get('pointerdown')?.({ button: 2 })
    expect(shell.openSiteInfo).not.toHaveBeenCalled()
    expect(shell.press).not.toHaveBeenCalled()
  })
})
