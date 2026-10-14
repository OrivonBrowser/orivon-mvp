import type { Row } from '../model.js'
import { h } from '../../shared/dom.js'
import { nymReason, nymStatusWords } from '../../shared/nym-words.js'
import type { RoutePart } from '../route-part.js'
import { renderTunnelList } from './route-list-row.js'
import { renderProxyTest } from './route-test-row.js'

const GROUP = 'Connections and tracking'

/** Rows spread into the section they belong to, so a feature adds its rows here and edits no other file. */
export const privacyNetworkRows: readonly Row[] = [
  {
    id: 'cookies',
    label: 'Cookies',
    help: 'Third-party cookies let a company follow you from site to site. Blocking them can sign you out of embedded content, such as a comment box or a video player. Scripts in an embedded frame can still read cookies already stored for their site.',
    keywords: ['cookie', 'cookies', 'third-party', 'third party', 'tracking', 'block', 'cross-site', 'sign out', 'embedded'],
    group: GROUP,
    control: {
      type: 'choice',
      key: 'privacy.cookies',
      options: [
        { value: 'all', label: 'Allow all cookies' },
        { value: 'blockThirdParty', label: 'Block third-party cookies' }
      ]
    }
  },
  {
    id: 'global-privacy-control',
    label: 'Ask sites not to sell or share my data',
    help: 'Sends the Global Privacy Control signal, which asks sites not to sell or share your data; some laws, such as California\'s, make sites honour it. Every site sees it as the Sec-GPC: 1 request header and as navigator.globalPrivacyControl in its pages, frames and workers. It is read when Orivon starts, and a private window follows the choice made where it was opened.',
    keywords: ['gpc', 'global privacy control', 'sell', 'share', 'opt out', 'ccpa', 'california', 'tracking', 'signal', 'sec-gpc'],
    group: GROUP,
    control: { type: 'toggle', key: 'privacy.globalPrivacyControl', locked: (state) => state.profiles?.isPrivate === true }
  },
  {
    id: 'global-privacy-control-restart',
    label: 'Start again to apply',
    help: 'The choice above is read when Orivon starts. Your tabs and windows are not restored.',
    keywords: ['restart', 'relaunch', 'apply', 'gpc'],
    group: GROUP,
    control: {
      type: 'action',
      label: 'Restart Orivon',
      run: async (state) => { await state.request('app', { type: 'relaunch' }) }
    },
    visible: (state) => state.isChangedSinceStart('privacy.globalPrivacyControl') && state.profiles?.isPrivate !== true
  },
  {
    id: 'do-not-track',
    label: 'Send a Do Not Track request',
    help: 'Most sites ignore it.',
    keywords: ['dnt', 'do not track', 'tracking', 'signal', 'header'],
    group: GROUP,
    control: { type: 'toggle', key: 'privacy.doNotTrack' }
  },
  {
    id: 'https-only',
    label: 'Always use secure connections',
    help: 'Loads every site over HTTPS and warns you before opening one that does not support it. This computer and your own network are left alone.',
    keywords: ['https', 'http', 'secure', 'encrypted', 'upgrade', 'ssl', 'tls', 'insecure', 'padlock', 'https-only'],
    group: GROUP,
    control: { type: 'toggle', key: 'privacy.httpsOnly' }
  },
  {
    id: 'secure-dns',
    label: 'Secure DNS',
    help: 'Looks up site addresses over an encrypted connection, so the network you are on cannot see or change them. .eth names are resolved separately and are not affected.',
    keywords: ['dns', 'doh', 'dns over https', 'cloudflare', 'quad9', 'resolver', 'lookup', 'encrypted dns', 'provider'],
    group: GROUP,
    control: {
      type: 'choice',
      key: 'privacy.secureDns',
      options: [
        { value: 'off', label: 'Off (use this computer\'s DNS)' },
        { value: 'automatic', label: 'Automatic (use secure DNS when the provider offers it)' },
        { value: 'cloudflare', label: 'Cloudflare (1.1.1.1)' },
        { value: 'quad9', label: 'Quad9 (9.9.9.9)' }
      ]
    }
  },
  {
    id: 'route-kind',
    label: 'Tunnel',
    help: 'Where the apps and websites you send through a tunnel leave from. Nym is a mixnet built into Orivon: each app or website gets a tunnel of its own, and the sites it reaches see an exit address, not this computer. Or use your own SOCKS5 address, such as Tor\'s. You turn it on for each app under Apps, and for each website from the key in the address bar, or for everything at once below; until then nothing goes through it.',
    keywords: ['tunnel', 'proxy', 'socks', 'socks5', 'tor', 'onion', 'route', 'vpn', 'anonymous', 'network', 'apps', 'sites', 'websites', 'nym', 'mixnet', 'built in'],
    group: GROUP,
    control: { type: 'choice', key: 'network.route.kind' }
  },
  {
    id: 'route-nym-enabled',
    label: 'Let Nym run',
    help: 'Turn it off and Nym stops. Every app and website set to use the tunnel, and the whole browser if you chose that, is then stopped rather than sent directly, until you turn it on again. A change applies at once.',
    keywords: ['nym', 'mixnet', 'tunnel', 'off', 'stop', 'switch', 'network'],
    group: GROUP,
    visible: (state) => state.value('network.route.kind') !== 'socks5',
    control: { type: 'toggle', key: 'network.nym.enabled' }
  },
  {
    id: 'route-nym-status',
    label: 'Nym',
    help: 'Nym\'s gateways see this computer\'s address; the sites an app reaches see only an exit address. It stops some minutes after the last app stops using it.',
    keywords: ['nym', 'mixnet', 'tunnel', 'status', 'gateway'],
    group: GROUP,
    visible: (state) => state.value('network.route.kind') !== 'socks5',
    control: { type: 'info', text: (state) => nymStatusWords(state.part<RoutePart>('route').nym) },
    below: (state) => {
      const reason = nymReason(state.part<RoutePart>('route').nym)
      return reason === undefined || reason === '' ? null : h('p', { className: 'muted', textContent: reason })
    }
  },
  {
    id: 'route-proxy',
    label: 'SOCKS5 address',
    help: 'Your own SOCKS5 server, such as Tor\'s 127.0.0.1:9050. Each app signs in with a user name of its own, so a server that separates circuits by it keeps the apps apart.',
    keywords: ['tunnel', 'proxy', 'socks', 'socks5', 'tor', 'onion', 'route', 'anonymous', 'network', 'apps', 'host', 'port', 'address'],
    group: GROUP,
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
    group: GROUP,
    control: { type: 'custom', render: renderProxyTest }
  },
  {
    id: 'route-everywhere',
    label: 'Send all of Orivon\'s traffic through the tunnel',
    help: 'Every website and app follows this unless you set it to off from its own switch, and so does what Orivon sends for itself: update checks, usage statistics you agreed to, search suggestions and the Web3 names Orivon reads. Left outside the tunnel: this computer, the connection to the tunnel itself, and the sites and apps you set to off. The IPFS and Swarm nodes Orivon can run are off meanwhile, because they connect to their peers themselves; IPFS is read through gateways instead.',
    keywords: ['tunnel', 'proxy', 'tor', 'everything', 'all traffic', 'whole browser', 'everywhere', 'vpn', 'anonymous', 'default'],
    group: GROUP,
    control: { type: 'toggle', key: 'network.tunnel.everywhere', // With your own address as the tunnel and no address set it cannot be turned on, but it can always be turned off.
      disabled: (state) => state.value('network.route.kind') !== 'nym' && String(state.value('network.route.proxy') ?? '').trim() === '' && state.value('network.tunnel.everywhere') !== true },
    below: (state) => state.part<RoutePart>('route').heldOn && state.value('network.tunnel.everywhere') === true
      ? h('p', { className: 'problem', role: 'status', textContent: 'This is on because your settings file could not be read, so Orivon does not guess that you wanted your traffic outside the tunnel; turn it off here if you did.' })
      : null
  },
  {
    id: 'route-sites',
    label: 'Sites and apps with their own tunnel setting',
    help: 'A website you turn the tunnel on for lives in your tunnel profile, one you turn it off for while everything else is on lives in your direct profile, and each profile keeps its cookies and storage apart from your normal browsing. Your extensions run in both profiles, each with settings of its own, and the direct profile\'s run only while one of its sites is open. The storage stays when you give the setting up, until you remove it here.',
    keywords: ['tunnel', 'proxy', 'tor', 'sites', 'websites', 'apps', 'storage', 'cookies', 'separate', 'remove', 'sign in'],
    group: GROUP,
    control: { type: 'custom', wide: true, render: renderTunnelList }
  }
]
