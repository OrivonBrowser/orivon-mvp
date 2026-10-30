import type { SettingKey } from '../../../../main/settings/schema.js'
import type { Row, Section } from '../model.js'
import type { SettingsState } from '../state.js'
import { h } from '../../shared/dom.js'
import { nymReason, nymStatusWords } from '../../shared/nym-words.js'
import type { RoutePart } from '../route-part.js'
import { renderTunnelList } from './route-list-row.js'
import { renderTunnelTest } from './route-test-row.js'

const TUNNEL = 'Defaults'
const NYM = 'Nym'
const OWN = 'Your proxy'
const SITES = 'Sites and apps'

/** A setting this window is held to is shown as it is, fixed. */
const held = (key: SettingKey) => (state: SettingsState): boolean => state.isHeld(key)

/** The line under a row of a private window that always goes through Nym. */
export const HELD_LINE = 'This private window always goes through Nym, so this is fixed here.'
export const heldNote = (state: SettingsState): string | null => state.profiles?.tunnel === 'nym' ? HELD_LINE : null
const heldLine = (state: SettingsState): HTMLElement | null => {
  const note = heldNote(state)
  return note === null ? null : h('p', { className: 'muted', role: 'status', textContent: note })
}

/** The row ids are stable: a deep link (`orivon://settings/tunnels#route-everywhere`) and the specs name them. */
const rows: readonly Row[] = [
  {
    id: 'route-kind',
    label: 'Default tunnel',
    help: 'The tunnel for everything that has no choice of its own: what Orivon sends for itself and the whole browser when you send all of it through a tunnel, and the Ethereum and IPFS nodes Orivon runs when they follow it. Each website and each app can use Nym or your own proxy whatever this says: you choose for a tab from the tunnel button in the address bar and keep it for a website with Always use for this site, and for an app under Apps; until you do, nothing goes through a tunnel. Nym is a mixnet built into Orivon: each app or website gets a tunnel of its own, and the sites it reaches see an exit address, not this computer. Your own proxy is a SOCKS5 address, such as Tor\'s.',
    keywords: ['tunnel', 'proxy', 'socks', 'socks5', 'tor', 'onion', 'route', 'vpn', 'anonymous', 'network', 'apps', 'sites', 'websites', 'nym', 'mixnet', 'built in'],
    group: TUNNEL,
    below: heldLine,
    control: { type: 'choice', key: 'network.route.kind', locked: held('network.route.kind') }
  },
  {
    id: 'route-everywhere',
    label: 'Send all of Orivon\'s traffic through the default tunnel',
    help: 'Every website and app follows this unless you set it to off or give it the other tunnel (a website keeps it with Always use for this site in the tunnel button), and so does what Orivon sends for itself: update checks, usage statistics you agreed to, search suggestions and the Web3 names Orivon reads. Left outside the tunnel: this computer, the connection to the tunnel itself, and the sites and apps you set to off. The IPFS and Swarm nodes Orivon can run connect to their peers themselves, so the switch under this one says whether they go through the tunnel too.',
    keywords: ['tunnel', 'proxy', 'tor', 'everything', 'all traffic', 'whole browser', 'everywhere', 'vpn', 'anonymous', 'default', 'enforce', 'browser-wide', 'browser wide'],
    group: TUNNEL,
    control: { type: 'toggle', key: 'network.tunnel.everywhere', locked: held('network.tunnel.everywhere'), // With your own address as the tunnel and no address set it cannot be turned on, but it can always be turned off.
      disabled: (state) => state.value('network.route.kind') !== 'nym' && String(state.value('network.route.proxy') ?? '').trim() === '' && state.value('network.tunnel.everywhere') !== true },
    below: (state) => heldLine(state) ?? (state.part<RoutePart>('route').heldOn && state.value('network.tunnel.everywhere') === true
      ? h('p', { className: 'problem', role: 'status', textContent: 'This is on because your settings file could not be read, so Orivon does not guess that you wanted your traffic outside the tunnel; turn it off here if you did.' })
      : null)
  },
  {
    id: 'route-nodes',
    label: 'Use tunnel to run network nodes (such as IPFS and Swarm)',
    help: 'Off: the IPFS and Swarm nodes, and the Ethereum service that checks .eth names, connect directly, so pages load faster, but the networks they ask can see this computer\'s address and what is asked for: the content, and the .eth names you open; the connections of the sites themselves still go through the tunnel. On: they go through the tunnel too, which is more private and much slower. This applies while Orivon\'s traffic goes through the tunnel; a website you tunnel by itself is then served from the nodes only while this is off. A change applies at once.',
    keywords: ['tunnel', 'nodes', 'node', 'ipfs', 'swarm', 'ethereum', 'light client', 'ens', 'network nodes', 'nym', 'tor', 'direct', 'private', 'faster', 'slower', 'peers'],
    group: TUNNEL,
    control: { type: 'toggle', key: 'network.tunnel.nodes' }
  },
  {
    id: 'route-nym-enabled',
    label: 'Let Nym run',
    help: 'Turn it off and Nym stops. Every app and website set to use the tunnel, and the whole browser if you chose that, is then stopped rather than sent directly, until you turn it on again. A change applies at once.',
    keywords: ['nym', 'mixnet', 'tunnel', 'off', 'stop', 'switch', 'network'],
    group: NYM,
    below: heldLine,
    control: { type: 'toggle', key: 'network.nym.enabled', locked: held('network.nym.enabled') }
  },
  {
    id: 'route-nym-status',
    label: 'Nym',
    help: 'Nym\'s gateways see this computer\'s address; the sites an app reaches see only an exit address. It stops some minutes after the last app stops using it.',
    keywords: ['nym', 'mixnet', 'tunnel', 'status', 'gateway'],
    group: NYM,
    control: { type: 'info', text: (state) => nymStatusWords(state.part<RoutePart>('route').nym) },
    below: (state) => {
      const reason = nymReason(state.part<RoutePart>('route').nym)
      return reason === undefined || reason === '' ? null : h('p', { className: 'muted', textContent: reason })
    }
  },
  {
    id: 'route-nym-privacy',
    label: 'Nym privacy',
    help: 'Balanced: uses little power. Someone watching your connection can see roughly when you are active, not what you do. Strongest: Nym\'s full protection, a steady stream of decoy traffic that hides when you are active. It uses about a third of a processor core for each open tunnel. A tunnel that is open is replaced when its app has nothing open on it, so an app that always has a connection open keeps its old level.',
    keywords: ['nym', 'mixnet', 'privacy', 'cover traffic', 'decoy', 'power', 'battery', 'cpu', 'processor', 'balanced', 'strongest', 'tunnel'],
    group: NYM,
    control: {
      type: 'choice',
      key: 'network.nym.privacy',
      options: [
        { value: 'balanced', label: 'Balanced' },
        { value: 'strongest', label: 'Strongest' }
      ]
    }
  },
  {
    id: 'route-nym-test',
    label: 'Test Nym',
    help: 'Brings Nym up, looks a name up through it and says how long that took.',
    keywords: ['tunnel', 'nym', 'mixnet', 'test', 'check', 'route'],
    group: NYM,
    control: { type: 'custom', render: renderTunnelTest('nym') }
  },
  {
    id: 'route-proxy',
    label: 'SOCKS5 address',
    help: 'Your own SOCKS5 server, such as Tor\'s 127.0.0.1:9050. Each app signs in with a user name of its own, so a server that separates circuits by it keeps the apps apart. A site or app uses it when you choose Your proxy for it, or when it is the default tunnel.',
    keywords: ['tunnel', 'proxy', 'socks', 'socks5', 'tor', 'onion', 'route', 'anonymous', 'network', 'apps', 'host', 'port', 'address'],
    group: OWN,
    below: heldLine,
    control: { type: 'text', key: 'network.route.proxy', placeholder: '127.0.0.1:9050', problem: 'Enter an address as host:port, like 127.0.0.1:9050', locked: held('network.route.proxy') }
  },
  {
    id: 'route-proxy-test',
    label: 'Test your proxy',
    help: 'Checks that a SOCKS5 server answers at that address. It opens no connection through it.',
    keywords: ['tunnel', 'proxy', 'socks', 'tor', 'test', 'check', 'route'],
    group: OWN,
    below: heldLine,
    control: { type: 'custom', render: renderTunnelTest('socks5') }
  },
  {
    id: 'route-sites',
    label: 'Sites and apps with their own tunnel setting',
    help: 'A website you keep on Nym lives in your Nym profile, one you keep on your proxy in your proxy profile, and one you keep off while everything else is on in your direct profile; a tab you send through a tunnel without keeping it for the site shows its sites from the same profiles while the tab lasts. Each profile keeps its cookies and storage apart from your normal browsing. Your extensions run in each profile, each with settings of its own, and the direct profile\'s run only while one of its sites is open. The storage stays when you give the setting up, until you remove it here.',
    keywords: ['tunnel', 'proxy', 'tor', 'sites', 'websites', 'apps', 'storage', 'cookies', 'separate', 'remove', 'sign in'],
    group: SITES,
    control: { type: 'custom', wide: true, render: renderTunnelList }
  }
]

export const tunnels: Section = {
  id: 'tunnels',
  title: 'Tunnels',
  intro: 'A tunnel sends what a site or an app does on the network through Nym or your own SOCKS5 proxy, so the sites it reaches do not see this computer. Pick a tunnel for a tab from the tunnel button in the address bar and keep it for the website with Always use for this site, for an app under Apps, or send everything through the default one here.',
  rows
}
