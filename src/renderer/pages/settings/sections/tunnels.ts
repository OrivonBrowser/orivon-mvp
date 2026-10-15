import type { Row, Section } from '../model.js'
import { h } from '../../shared/dom.js'
import { nymReason, nymStatusWords } from '../../shared/nym-words.js'
import type { RoutePart } from '../route-part.js'
import { renderTunnelList } from './route-list-row.js'
import { renderProxyTest } from './route-test-row.js'

const TUNNEL = 'Tunnel'
const NYM = 'Nym'
const OWN = 'Your SOCKS5 tunnel'
const CHECK = 'Check that it works'
const SITES = 'Sites and apps'

/** The row ids are stable: a deep link (`orivon://settings/tunnels#route-everywhere`) and the specs name them. */
const rows: readonly Row[] = [
  {
    id: 'route-kind',
    label: 'Tunnel',
    help: 'Where the apps and websites you send through a tunnel leave from. Nym is a mixnet built into Orivon: each app or website gets a tunnel of its own, and the sites it reaches see an exit address, not this computer. Or use your own SOCKS5 address, such as Tor\'s. You turn a tunnel on for each app under Apps, for each website from the tunnel button in the address bar, or for everything at once with the switch under this one; until then nothing goes through it.',
    keywords: ['tunnel', 'proxy', 'socks', 'socks5', 'tor', 'onion', 'route', 'vpn', 'anonymous', 'network', 'apps', 'sites', 'websites', 'nym', 'mixnet', 'built in'],
    group: TUNNEL,
    control: { type: 'choice', key: 'network.route.kind' }
  },
  {
    id: 'route-everywhere',
    label: 'Send all of Orivon\'s traffic through the tunnel',
    help: 'Every website and app follows this unless you set it to off from its own switch, and so does what Orivon sends for itself: update checks, usage statistics you agreed to, search suggestions and the Web3 names Orivon reads. Left outside the tunnel: this computer, the connection to the tunnel itself, and the sites and apps you set to off. The IPFS and Swarm nodes Orivon can run are off meanwhile, because they connect to their peers themselves; IPFS is read through gateways instead.',
    keywords: ['tunnel', 'proxy', 'tor', 'everything', 'all traffic', 'whole browser', 'everywhere', 'vpn', 'anonymous', 'default', 'enforce', 'browser-wide', 'browser wide'],
    group: TUNNEL,
    control: { type: 'toggle', key: 'network.tunnel.everywhere', // With your own address as the tunnel and no address set it cannot be turned on, but it can always be turned off.
      disabled: (state) => state.value('network.route.kind') !== 'nym' && String(state.value('network.route.proxy') ?? '').trim() === '' && state.value('network.tunnel.everywhere') !== true },
    below: (state) => state.part<RoutePart>('route').heldOn && state.value('network.tunnel.everywhere') === true
      ? h('p', { className: 'problem', role: 'status', textContent: 'This is on because your settings file could not be read, so Orivon does not guess that you wanted your traffic outside the tunnel; turn it off here if you did.' })
      : null
  },
  {
    id: 'route-nym-enabled',
    label: 'Let Nym run',
    help: 'Turn it off and Nym stops. Every app and website set to use the tunnel, and the whole browser if you chose that, is then stopped rather than sent directly, until you turn it on again. A change applies at once.',
    keywords: ['nym', 'mixnet', 'tunnel', 'off', 'stop', 'switch', 'network'],
    group: NYM,
    visible: (state) => state.value('network.route.kind') !== 'socks5',
    control: { type: 'toggle', key: 'network.nym.enabled' }
  },
  {
    id: 'route-nym-status',
    label: 'Nym',
    help: 'Nym\'s gateways see this computer\'s address; the sites an app reaches see only an exit address. It stops some minutes after the last app stops using it.',
    keywords: ['nym', 'mixnet', 'tunnel', 'status', 'gateway'],
    group: NYM,
    visible: (state) => state.value('network.route.kind') !== 'socks5',
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
    visible: (state) => state.value('network.route.kind') !== 'socks5',
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
    id: 'route-proxy',
    label: 'SOCKS5 address',
    help: 'Your own SOCKS5 server, such as Tor\'s 127.0.0.1:9050. Each app signs in with a user name of its own, so a server that separates circuits by it keeps the apps apart.',
    keywords: ['tunnel', 'proxy', 'socks', 'socks5', 'tor', 'onion', 'route', 'anonymous', 'network', 'apps', 'host', 'port', 'address'],
    group: OWN,
    visible: (state) => state.value('network.route.kind') === 'socks5',
    control: { type: 'text', key: 'network.route.proxy', placeholder: '127.0.0.1:9050', problem: 'Enter an address as host:port, like 127.0.0.1:9050' }
  },
  {
    id: 'route-proxy-test',
    label: 'Test the tunnel',
    helpFor: (state) => state.value('network.route.kind') === 'socks5'
      ? 'Checks that a SOCKS5 server answers at that address. It opens no connection through it.'
      : 'Brings Nym up, looks a name up through it and says how long that took.',
    keywords: ['tunnel', 'proxy', 'socks', 'tor', 'test', 'check', 'route', 'nym'],
    group: CHECK,
    control: { type: 'custom', render: renderProxyTest }
  },
  {
    id: 'route-sites',
    label: 'Sites and apps with their own tunnel setting',
    help: 'A website you turn the tunnel on for lives in your tunnel profile, one you turn it off for while everything else is on lives in your direct profile, and each profile keeps its cookies and storage apart from your normal browsing. Your extensions run in both profiles, each with settings of its own, and the direct profile\'s run only while one of its sites is open. The storage stays when you give the setting up, until you remove it here.',
    keywords: ['tunnel', 'proxy', 'tor', 'sites', 'websites', 'apps', 'storage', 'cookies', 'separate', 'remove', 'sign in'],
    group: SITES,
    control: { type: 'custom', wide: true, render: renderTunnelList }
  }
]

export const tunnels: Section = {
  id: 'tunnels',
  title: 'Tunnels',
  intro: 'A tunnel sends what a site or an app does on the network through Nym or your own SOCKS5 server, so the sites it reaches do not see this computer. Turn it on for one website from the tunnel button in the address bar, for an app under Apps, or here for everything.',
  rows
}
