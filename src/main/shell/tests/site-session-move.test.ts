import { describe, expect, it } from 'vitest'
import { addressOfTab, tabMovesFor } from '../site-session-move.js'
import type { TabInSession } from '../site-session-move.js'

const SITE = 'https://news.example'
const OWN = 'persist:site-abc'
const tab = (over: Partial<TabInSession> & { id: string }): TabInSession => ({ url: `${SITE}/a`, partition: undefined, showsPage: true, ...over })

describe('which tabs move when a website\'s tunnel changes', () => {
  it('moves the tabs on the website into the session its state calls for', () => {
    const tabs = [tab({ id: '1' }), tab({ id: '2', url: `${SITE}/b?c=1` }), tab({ id: '3', url: 'https://other.example/' })]
    expect(tabMovesFor(SITE, tabs, () => OWN)).toEqual([{ id: '1', url: `${SITE}/a`, to: OWN }, { id: '2', url: `${SITE}/b?c=1`, to: OWN }])
  })

  it('moves a tab in the website\'s own session back to the shared one', () => {
    expect(tabMovesFor(SITE, [tab({ id: '1', partition: OWN })], () => undefined)).toEqual([{ id: '1', url: `${SITE}/a`, to: undefined }])
  })

  it('leaves a tab that is already where it belongs', () => {
    expect(tabMovesFor(SITE, [tab({ id: '1', partition: OWN })], () => OWN)).toEqual([])
  })

  it('leaves the new-tab page, an internal page and a tab asleep, and a tab in a temporary routed session', () => {
    const tabs = [tab({ id: '1', showsPage: false }), tab({ id: '2', partition: 'orivon-route-tab-0123456789abcdef01' })]
    expect(tabMovesFor(SITE, tabs, () => OWN)).toEqual([])
  })

  it('leaves a tab whose address has no origin', () => {
    expect(tabMovesFor(SITE, [tab({ id: '1', url: 'about:blank' })], () => OWN)).toEqual([])
  })

  it('asks for the session of each tab\'s own choice, so a website\'s entry changing never takes a tunnel tab out of its tunnel', () => {
    const PROXY = 'persist:proxy-profile'
    const tabs = [tab({ id: '1', tunnelChoice: 'socks5', partition: PROXY }), tab({ id: '2' }), tab({ id: '3', tunnelChoice: 'direct' })]
    const asked: Array<[string, unknown]> = []
    const moves = tabMovesFor(SITE, tabs, (url, choice) => { asked.push([url, choice]); return choice === 'socks5' ? PROXY : OWN })
    expect(asked).toEqual([[`${SITE}/a`, 'socks5'], [`${SITE}/a`, undefined], [`${SITE}/a`, 'direct']])
    expect(moves).toEqual([{ id: '2', url: `${SITE}/a`, to: OWN }, { id: '3', url: `${SITE}/a`, to: OWN }])
  })
})

describe('the address a tab is on for its session', () => {
  it('is the page\'s, or while the tab has none the address its first navigation leads to', () => {
    expect(addressOfTab(`${SITE}/a`, { inflightTarget: 'https://other.example/' })).toBe(`${SITE}/a`)
    expect(addressOfTab('', { inflightTarget: `${SITE}/b` })).toBe(`${SITE}/b`)
    expect(addressOfTab('', {})).toBe('')
  })

  it('puts a tab that is opening the website among the tabs on it', () => {
    const opening = tab({ id: '1', url: addressOfTab('', { inflightTarget: `${SITE}/b` }) })
    expect(tabMovesFor(SITE, [opening], () => OWN)).toEqual([{ id: '1', url: `${SITE}/b`, to: OWN }])
  })
})
