import { describe, expect, it } from 'vitest'
import { badgeFor, badgesFor, BADGE_LIMIT, filterSites, hostOf, sentenceFor, SHOWN_LIMIT, visibleSites } from '../settings/sites/sites-model.js'
import type { SiteSummary } from '../settings/sites/sites-model.js'

const site = (origin: string, ...kinds: Array<[kind: string, label: string, value: 'allow' | 'block']>): SiteSummary =>
  ({ origin, kinds: kinds.map(([kind, label, value]) => ({ kind: kind as never, label, value })) })

const SHOP = site('https://shop.example', ['camera', 'Camera', 'allow'], ['popups', 'Pop-ups and redirects', 'allow'], ['javascript', 'JavaScript', 'block'], ['location', 'Location', 'block'], ['midi', 'MIDI devices', 'block'])

describe('a site\'s badges', () => {
  it('say what the site was told: the kind and allowed or blocked, with the tone to match', () => {
    expect(badgeFor({ kind: 'camera', label: 'Camera', value: 'allow' })).toEqual({ text: 'Camera allowed', tone: 'ok' })
    expect(badgeFor({ kind: 'javascript', label: 'JavaScript', value: 'block' })).toEqual({ text: 'JavaScript blocked', tone: 'danger' })
  })

  it('use a short name where the kind\'s label is long', () => {
    expect(badgeFor({ kind: 'popups', label: 'Pop-ups and redirects', value: 'allow' }).text).toBe('Pop-ups allowed')
    expect(badgeFor({ kind: 'midi', label: 'MIDI devices', value: 'block' }).text).toBe('MIDI blocked')
  })

  it('show three and count the rest', () => {
    expect(BADGE_LIMIT).toBe(3)
    const { shown, more } = badgesFor(SHOP)
    expect(shown.map((badge) => badge.text)).toEqual(['Camera allowed', 'Pop-ups allowed', 'JavaScript blocked'])
    expect(more).toBe(2)
  })

  it('show all of three or fewer, with no count', () => {
    const three = site('https://a.example', ['camera', 'Camera', 'allow'], ['location', 'Location', 'block'], ['idle', 'Idle detection', 'block'])
    expect(badgesFor(three)).toMatchObject({ more: 0, shown: expect.arrayContaining([]) })
    expect(badgesFor(three).shown).toHaveLength(3)
    expect(badgesFor(site('https://b.example')).shown).toEqual([])
  })

  it('name the USB devices a site was given first, in the singular for one', () => {
    expect(badgesFor({ ...SHOP, devices: 1 }).shown[0]).toEqual({ text: '1 device allowed', tone: 'ok' })
    expect(badgesFor({ origin: 'https://k.example', kinds: [], devices: 2 }).shown).toEqual([{ text: '2 devices allowed', tone: 'ok' }])
    expect(badgesFor({ ...SHOP, devices: 0 }).shown[0]?.text).toBe('Camera allowed')
    expect(sentenceFor({ origin: 'https://k.example', kinds: [], devices: 2 })).toBe('k.example: 2 devices allowed')
  })

  it('read as one sentence for a screen reader, with every answer', () => {
    expect(sentenceFor(SHOP)).toBe('shop.example: Camera allowed, Pop-ups allowed, JavaScript blocked, Location blocked, MIDI blocked')
  })
})

describe('the search over sites', () => {
  const sites = [site('https://alpha.example'), site('http://127.0.0.1:8080'), site('https://news.alpha.org'), site('https://beta.example')]

  it('keeps every site for an empty query, in the order given', () => {
    expect(filterSites(sites, '  ')).toEqual(sites)
  })

  it('keeps a site whose host holds every word, ignoring case', () => {
    expect(filterSites(sites, 'ALPHA').map((s) => hostOf(s.origin))).toEqual(['alpha.example', 'news.alpha.org'])
    expect(filterSites(sites, 'alpha org').map((s) => hostOf(s.origin))).toEqual(['news.alpha.org'])
    expect(filterSites(sites, 'zzz')).toEqual([])
  })

  it('does not look at the scheme, which the person does not see', () => {
    expect(filterSites(sites, 'https')).toEqual([])
    expect(filterSites(sites, '127.0.0.1')).toHaveLength(1)
  })
})

describe('how many sites show', () => {
  const many = Array.from({ length: SHOWN_LIMIT + 7 }, (_unused, index) => site(`https://s${String(index)}.example`))

  it('shows 100 and counts the rest', () => {
    expect(visibleSites(many, false)).toMatchObject({ hidden: 7 })
    expect(visibleSites(many, false).shown).toHaveLength(100)
  })

  it('shows everything when asked, and when there are 100 or fewer', () => {
    expect(visibleSites(many, true)).toMatchObject({ hidden: 0 })
    expect(visibleSites(many, true).shown).toHaveLength(107)
    expect(visibleSites(many.slice(0, 100), false).hidden).toBe(0)
  })
})
