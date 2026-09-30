import type { Row } from '../model.js'

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
    help: 'Sends the Global Privacy Control signal with every request. Sites in some regions must honour it.',
    keywords: ['gpc', 'global privacy control', 'sell', 'share', 'opt out', 'ccpa', 'tracking', 'signal'],
    group: GROUP,
    control: { type: 'toggle', key: 'privacy.globalPrivacyControl' }
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
  }
]
