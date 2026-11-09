import { describe, expect, it } from 'vitest'
import { choiceForNewTabFrom } from '../new-tab-tunnel.js'
import type { NewTabSource } from '../new-tab-tunnel.js'
import type { TunnelEntry } from '../../route/route-state.js'

const SITE = 'https://news.example'

/** A tab on `SITE` in the shared session, whose website has `entry` (none by default). */
const source = (over: Partial<NewTabSource> = {}, entry?: TunnelEntry): NewTabSource => ({
  choice: undefined,
  address: `${SITE}/page`,
  partition: undefined,
  isApp: () => false,
  entryOf: (origin) => origin === SITE ? entry : undefined,
  ...over
})

describe('the choice a blank tab takes from the tab it is opened from', () => {
  it('is the tab\'s own choice, whatever it shows', () => {
    for (const choice of ['nym', 'socks5', 'direct'] as const) {
      expect(choiceForNewTabFrom(source({ choice })), choice).toBe(choice)
      expect(choiceForNewTabFrom(source({ choice, address: undefined })), `${choice} on a new tab`).toBe(choice)
      expect(choiceForNewTabFrom(source({ choice, address: 'orivon://settings/' })), `${choice} on a page of the shell`).toBe(choice)
    }
  })

  it('is the tunnel of the entry of the website the tab shows, when the tab has no choice', () => {
    expect(choiceForNewTabFrom(source({}, 'nym'))).toBe('nym')
    expect(choiceForNewTabFrom(source({}, 'socks5'))).toBe('socks5')
    expect(choiceForNewTabFrom(source({ address: `${SITE}/other?x=1#y` }, 'socks5')), 'any page of the website').toBe('socks5')
  })

  it('is the entry of the website the tab is opening when its page has not come', () => {
    expect(choiceForNewTabFrom(source({ address: `${SITE}/` }, 'nym'))).toBe('nym')
  })

  it('reads the entry in a profile session too, which is where the entry put the page', () => {
    for (const partition of ['persist:tunnel-profile', 'persist:proxy-profile', 'persist:direct-profile', 'tunnel-profile-memory']) {
      expect(choiceForNewTabFrom(source({ partition }, 'nym')), partition).toBe('nym')
    }
  })

  it('is none for a tab with no choice on a website with no entry or an off entry, and on a new tab or a page of the shell', () => {
    expect(choiceForNewTabFrom(source())).toBeUndefined()
    expect(choiceForNewTabFrom(source({}, 'off'))).toBeUndefined()
    expect(choiceForNewTabFrom(source({ address: undefined }, 'nym'))).toBeUndefined()
    expect(choiceForNewTabFrom(source({ address: 'orivon://settings/' }, 'nym'))).toBeUndefined()
  })

  it('reads no entry of an installed app, a page that cannot go through a tunnel, or a page in a session an app or a temporary route made', () => {
    expect(choiceForNewTabFrom(source({ isApp: (origin) => origin === SITE }, 'nym')), 'an installed app').toBeUndefined()
    for (const address of ['http://localhost:3000/', 'http://127.0.0.1:8080/', 'file:///home/me/page.html']) {
      expect(choiceForNewTabFrom(source({ address, entryOf: () => 'nym' })), address).toBeUndefined()
    }
    for (const partition of ['persist:app-https://app.example', 'temporary-route-1']) expect(choiceForNewTabFrom(source({ partition }, 'nym')), partition).toBeUndefined()
  })

  it('keeps the tab\'s choice for a page that has an entry of another tunnel: the tab\'s choice is the tab\'s', () => {
    expect(choiceForNewTabFrom(source({ choice: 'socks5' }, 'nym'))).toBe('socks5')
    expect(choiceForNewTabFrom(source({ choice: 'direct' }, 'nym'))).toBe('direct')
  })
})
