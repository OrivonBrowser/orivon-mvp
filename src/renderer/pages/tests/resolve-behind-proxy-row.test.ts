// The Settings row of the name relay's switch: where it sits, what it is called, what it tells the person, and that it is the
// toggle of the key the main process reads.

import { describe, expect, it } from 'vitest'
import { privacyNetworkRows } from '../settings/sections/privacy-network.js'
import type { Row } from '../settings/model.js'

const row = privacyNetworkRows.find((candidate) => candidate.id === 'resolve-behind-proxy') as Row

describe('the row that turns the name relay on', () => {
  it('follows Secure DNS, whose provider it uses, in the same group', () => {
    const ids = privacyNetworkRows.map((candidate) => candidate.id)
    expect(ids.indexOf('resolve-behind-proxy')).toBe(ids.indexOf('secure-dns') + 1)
    expect(row.group).toBe(privacyNetworkRows.find((candidate) => candidate.id === 'secure-dns')?.group)
  })

  it('is a toggle of the setting, with no condition on when it is shown', () => {
    expect(row.control).toEqual({ type: 'toggle', key: 'privacy.resolveBehindProxy' })
    expect(row.visible).toBeUndefined()
  })

  it('is called what the person is told it does, and its keywords find it by the words a person searches with', () => {
    expect(row.label).toBe('Look up site addresses in Orivon, not in your proxy')
    expect(row.keywords).toEqual(['proxy', 'dns', 'lookup', 'resolve', 'address', 'doh', 'intranet', 'webrtc'])
  })

  it('says what it costs: names only the proxy finds, a proxy that asks to sign in, peer-to-peer calls, Tor, tunnels, and that it applies at once', () => {
    for (const part of [
      'Orivon looks up each site\'s address itself, through the proxy, with your Secure DNS provider (Quad9 when Secure DNS is off or automatic)',
      'the proxy still sees each site\'s name when a secure connection starts',
      'Names only your proxy can find, such as a company\'s internal sites, do not open unless they are among your system\'s proxy exceptions, and a proxy that asks you to sign in does not work.',
      'a proxy script your system uses, are still looked up on this computer',
      'Calls and other peer-to-peer connections in sites go through the proxy too, and may not connect.',
      'Do not use it if your proxy is Tor or another anonymity network.',
      'Tunnels are not affected: they look names up at their far end. Applied at once.'
    ]) expect(row.help, part).toContain(part)
  })
})
