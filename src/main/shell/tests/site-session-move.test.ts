import { describe, expect, it } from 'vitest'
import { tabMovesFor } from '../site-session-move.js'
import type { TabInSession } from '../site-session-move.js'

const SITE = 'https://news.example'
const OWN = 'persist:site-abc'
const tab = (over: Partial<TabInSession> & { id: string }): TabInSession => ({ url: `${SITE}/a`, partition: undefined, showsPage: true, ...over })

describe('which tabs move when a website\'s tunnel changes', () => {
  it('moves the tabs on the website into the session its state calls for', () => {
    const tabs = [tab({ id: '1' }), tab({ id: '2', url: `${SITE}/b?c=1` }), tab({ id: '3', url: 'https://other.example/' })]
    expect(tabMovesFor(SITE, tabs, () => OWN)).toEqual([{ id: '1', url: `${SITE}/a`, to: OWN }, { id: '2', url: `${SITE}/b?c=1`, to: OWN }, { id: '3', url: 'https://other.example/', to: OWN }].slice(0, 2))
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
})
