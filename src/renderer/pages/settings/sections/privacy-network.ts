import type { Row } from '../model.js'
import { h } from '../../shared/dom.js'
import { nymReason, nymStatusWords } from '../../../nym-words.js'
import type { RoutePart } from '../route-part.js'
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
    label: 'Tunnel for apps',
    help: 'Where the apps you send through a tunnel leave from. Nym is a mixnet built into Orivon: each app gets a tunnel of its own, and the sites it reaches see an exit address, not this computer. Or use your own SOCKS5 address, such as Tor\'s. You turn the tunnel on for each app under Apps; until then nothing goes through it. Websites do not use it.',
    keywords: ['tunnel', 'proxy', 'socks', 'socks5', 'tor', 'onion', 'route', 'vpn', 'anonymous', 'network', 'apps', 'nym', 'mixnet', 'built in'],
    group: GROUP,
    control: { type: 'choice', key: 'network.route.kind' }
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
  }
]
