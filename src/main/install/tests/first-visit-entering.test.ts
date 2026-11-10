import { describe, expect, it, vi } from 'vitest'
import { runFirstVisit } from '../first-visit.js'
import { TAB, depsOf, harness, present, settled } from './first-visit.test-helpers.js'

// The tab a visit sends into the app is named before the app is served and let go once it is sent, so the pages that load
// again when the app starts to be served do not load that one twice.

describe('runFirstVisit and the tab it enters', () => {
  it('names the tab before the app is served and lets it go after the tab is sent in', async () => {
    const h = harness()
    const entering = vi.fn((tab: object | undefined) => { h.events.push(`entering:${(tab as typeof TAB | undefined)?.id ?? 'none'}`); return () => { h.events.push('released') } })
    const result = await runFirstVisit({ ...depsOf(h), entering }, h.origin, h.url, present, h.host)
    expect(result.outcome).toBe('entered')
    await settled(result)
    expect(h.events.indexOf('entering:the-tab')).toBeGreaterThan(-1)
    expect(h.events.indexOf('entering:the-tab')).toBeLessThan(h.events.indexOf('serve-live'))
    expect(h.events.indexOf('enter')).toBeLessThan(h.events.indexOf('released'))
  })

  it('lets it go when the app could not be served and the tab stays a website', async () => {
    const h = harness({ live: false })
    const released = vi.fn()
    const result = await runFirstVisit({ ...depsOf(h), entering: () => released }, h.origin, h.url, present, h.host)
    expect(result.outcome).toBe('failed')
    expect(released).toHaveBeenCalledOnce()
  })

  it('empties the website\'s page, then waits for the origin to settle its workers, and only then loads the tab as the app', async () => {
    const h = harness()
    const host = { ...h.host, blank: async () => { h.events.push('blank') } }
    const settledOrigin = vi.fn(async () => { h.events.push('settled'); return true })
    const result = await runFirstVisit({ ...depsOf(h), settled: settledOrigin }, h.origin, h.url, present, host)
    await settled(result)
    expect(h.events.indexOf('serve-live')).toBeLessThan(h.events.indexOf('blank'))
    expect(h.events.indexOf('blank')).toBeLessThan(h.events.indexOf('settled'))
    expect(h.events.indexOf('settled')).toBeLessThan(h.events.indexOf('enter'))
    expect(settledOrigin).toHaveBeenCalledWith(h.origin)
  })

  it('loads the tab as the app even when the origin could not settle, so the app opens; its worker\'s answers then have no grants', async () => {
    const h = harness()
    const result = await runFirstVisit({ ...depsOf(h), settled: async () => false }, h.origin, h.url, present, h.host)
    await settled(result)
    expect(h.events).toContain('enter')
  })
})
