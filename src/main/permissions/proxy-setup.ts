// What the tunnel menu needs of the settings to set the person's proxy in place: its saved address, saving one the way Settings
// does (the same store, so the address is checked, kept and followed the same way) and the Test of a tunnel; and the three
// settings of the tunnel of the whole browser, moved the same way. Electron-free.
import { probeSocks5 } from '../../broker/route/socks5-probe.js'
import type { SubsystemContext } from '../registry.js'
import { testTunnel } from '../route/route-domain.js'
import type { SettingsStore } from '../settings/settings-store.js'
import type { ProxySetup } from './site-info-controller.js'
import type { BrowserTunnels } from './site-info-browser.js'
import type { BrowserTunnelTab } from './site-info.js'

export function proxySetup (ctx: Pick<SubsystemContext, 'routes'>, settings: Pick<SettingsStore, 'get' | 'set'>): ProxySetup {
  return {
    address: () => settings.get('network.route.proxy'),
    save: (text) => {
      const result = settings.set('network.route.proxy', text)
      return result.ok ? 'ok' : result.reason === 'locked' ? 'refused' : 'invalid'
    },
    test: async (kind) => {
      const routes = ctx.routes
      if (routes === undefined) return { ok: false, reason: 'no-proxy' }
      return await testTunnel(kind, { proxy: () => settings.get('network.route.proxy'), probe: probeSocks5, nym: routes.nym })
    }
  }
}

/** The settings the Browser-wide panel moves, each through the store Settings uses, so a window held to a tunnel or a file that could not be read refuses them there too. */
export function browserTunnels (settings: Pick<SettingsStore, 'get' | 'set'>, tabs: () => readonly BrowserTunnelTab[]): BrowserTunnels {
  return {
    tabs,
    nodes: () => settings.get('network.tunnel.nodes'),
    setKind: (kind) => settings.set('network.route.kind', kind).ok,
    setEverywhere: (on) => settings.set('network.tunnel.everywhere', on).ok,
    setNodes: (on) => settings.set('network.tunnel.nodes', on).ok
  }
}
