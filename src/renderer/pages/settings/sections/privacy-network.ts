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
    help: 'Looks up site addresses over an encrypted connection, so the network you are on cannot see or change them. By default Orivon asks Quad9, a non-profit resolver, and if Quad9 cannot be reached it uses this computer\'s own DNS, so a network that blocks Quad9 still works. Quad9 learns the names of the sites you open, as your network\'s DNS did. Sites you send through a tunnel are looked up at the tunnel\'s far end, never here, and .eth names are resolved separately.',
    keywords: ['dns', 'doh', 'dns over https', 'cloudflare', 'quad9', 'resolver', 'lookup', 'encrypted dns', 'provider'],
    group: GROUP,
    control: {
      type: 'choice',
      key: 'privacy.secureDns',
      options: [
        { value: 'quad9Fallback', label: 'Quad9, or this computer\'s DNS if Quad9 cannot be reached' },
        { value: 'off', label: 'Off (use this computer\'s DNS)' },
        { value: 'automatic', label: 'Automatic (use secure DNS when the provider offers it)' },
        { value: 'cloudflare', label: 'Cloudflare only (1.1.1.1)' },
        { value: 'quad9', label: 'Quad9 only (9.9.9.9)' }
      ]
    }
  }
]
