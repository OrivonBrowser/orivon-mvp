import { describe, expect, it } from 'vitest'
import { isEnteringPage } from '../../sessions/stale-pages.js'
import { enteringTab } from '../entering-tab.js'

const page = {}
const tab = { tabId: '7', window: { tabs: { liveWebContents: (id: string) => id === '7' ? page : undefined } } }

describe('the tab a visit sends into the app', () => {
  it('is marked until the visit lets it go', () => {
    const release = enteringTab(tab)
    expect(isEnteringPage(page)).toBe(true)
    release()
    expect(isEnteringPage(page)).toBe(false)
  })

  it('needs no mark when the visit has no tab, or the tab has no live page', () => {
    expect(() => { enteringTab(undefined)() }).not.toThrow()
    expect(() => { enteringTab({ tabId: '9', window: { tabs: { liveWebContents: () => undefined } } })() }).not.toThrow()
    expect(isEnteringPage({})).toBe(false)
  })
})
