import { describe, expect, it, vi } from 'vitest'
import { createFirstVisit, runFirstVisit } from '../first-visit.js'
import { VERIFIED, WEBSITE, CONTENT, DECLARED, DIFFERENT, bundle, harness, TAB, present, depsOf, run, LATE, settled, grantsOf } from './first-visit.test-helpers.js'
import type { Harness } from './first-visit.test-helpers.js'

// A first visit to an app an ordinary website serves, and what Orivon calls an origin (first, known, settling, declined).

describe('runFirstVisit, for an app an ordinary website serves', () => {
  const site = (overrides: Parameters<typeof harness>[0] = {}): Harness => harness({ origin: WEBSITE, ...overrides })

  it('is served live as a verifier\'s is, every file checked as it is served, and enters at once', async () => {
    const h = site()
    const result = await run(h, present, undefined, LATE)
    expect(h.events.slice(0, 7)).toEqual(['read', 'declaration', 'ask', 'serve-live', 'remember', 'enter'])
    expect(vi.mocked(h.loader.serveLive).mock.calls[0]?.[1]).toBe(DECLARED.declaration)
    expect(h.loader.fetchForInstall).not.toHaveBeenCalled()
    expect(await grantsOf(h)).toEqual(['fs'])
    expect(await settled(result)).toBe('pinned')
  })

  it('serves a site that declares no tree live too, on Orivon\'s own checks', async () => {
    const h = site({ declarations: [{ kind: 'none' }] })
    const result = await run(h)
    expect(result.outcome).toBe('entered')
    expect(vi.mocked(h.loader.serveLive).mock.calls[0]?.[1]).toBeUndefined()
    await settled(result)
  })

  it('shows the retry sheet when its tree cannot be read, and enters nothing', async () => {
    const h = site({ declarations: [{ kind: 'failed', reason: 'HTTP 503' }], choices: ['leave'] })
    expect(await run(h)).toMatchObject({ outcome: 'failed' })
    expect(h.loader.serveLive).not.toHaveBeenCalled()
    expect(await grantsOf(h)).toEqual([])
  })

  it('opens nothing and grants nothing when it cannot be served live, rather than let an unchecked page run beside a granted one', async () => {
    const h = site({ live: false })
    expect(await run(h)).toMatchObject({ outcome: 'failed' })
    expect(h.events).not.toContain('enter')
    expect(await grantsOf(h)).toEqual([])
  })

  it('blocks within the background download when the files differ from the declaration', async () => {
    const mismatched = bundle(WEBSITE, { declaration: DIFFERENT, content: CONTENT })
    const h = site({ bundles: [mismatched] })
    expect(await settled(await run(h))).toBe('blocked')
    expect(h.blocked).toHaveBeenCalledWith(WEBSITE, expect.objectContaining({ kind: 'blocked' }), TAB)
    expect(h.broker.app.isRegisteredSync(WEBSITE)).toBe(false)
    expect(await grantsOf(h)).toEqual([])
    expect(h.loader.installFetched).not.toHaveBeenCalled()
  })

  it('looks a second time before calling it tampering, since a site may have been deployed meanwhile', async () => {
    const h = site({ bundles: [bundle(WEBSITE, { declaration: DIFFERENT }), bundle(WEBSITE)] })
    expect(await settled(await run(h))).toBe('pinned')
    expect(h.loader.fetchForInstall).toHaveBeenCalledTimes(2)
    const twice = site({ bundles: [bundle(WEBSITE, { declaration: DIFFERENT }), bundle(WEBSITE, { declaration: DIFFERENT })] })
    expect(await settled(await run(twice))).toBe('blocked')
    expect(twice.loader.fetchForInstall).toHaveBeenCalledTimes(2)
  })

  it('does not look twice at content a name or address proved, which cannot be redeployed under the same root', async () => {
    const h = site({ bundles: [bundle(WEBSITE, { declaration: DIFFERENT, content: CONTENT })] })
    await settled(await run(h))
    expect(h.loader.fetchForInstall).toHaveBeenCalledTimes(1)
  })
})


describe('createFirstVisit', () => {
  const otherTab = (h: Harness): Harness['host'] => ({ ...h.host, tab: () => ({ id: 'another-tab' }) })
  function over (h: Harness, overrides: Partial<{ untouched: (origin: string) => boolean, servedFromCache: (origin: string) => boolean }> = {}): ReturnType<typeof createFirstVisit> {
    return createFirstVisit({ deps: depsOf(h), untouched: () => false, servedFromCache: () => false, ...overrides })
  }

  it('calls an origin Orivon has never held a first visit, and one it holds known', async () => {
    const h = harness()
    const visit = over(h)
    expect(await visit.kindOf(h.origin)).toBe('first')
    await settled(await run(h))
    expect(await visit.kindOf(h.origin)).toBe('known')
  })

  it('calls an origin settling while its background pin runs, so a page\'s own hint does not start a second install', async () => {
    let release = (): void => {}
    const h = harness()
    vi.mocked(h.loader.fetchForInstall).mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return bundle(h.origin)
    })
    const visit = over(h)
    const result = await visit.run(h.origin, h.url, present, h.host)
    expect(result.outcome).toBe('entered')
    await vi.waitFor(() => { expect(h.loader.fetchForInstall).toHaveBeenCalled() })
    expect(await visit.kindOf(h.origin)).toBe('settling')
    release()
    await vi.waitFor(async () => { expect(await visit.kindOf(h.origin)).toBe('known') })
  })

  it('calls an origin the person pressed Deny for declined, and an origin they escaped from still a first visit', async () => {
    const denied = harness({ answer: false })
    await run(denied)
    expect(await over(denied).kindOf(denied.origin)).toBe('declined')
    const escaped = harness({ answer: 'dismissed' })
    await run(escaped)
    expect(await over(escaped).kindOf(escaped.origin)).toBe('first')
  })

  it('does not ask again this run after Escape, in any tab, and keeps what it staged; nothing is written down', async () => {
    const staged = bundle(VERIFIED)
    const h = harness({ bundles: [staged], answer: 'dismissed' })
    const visit = over(h)
    const first = await visit.run(h.origin, h.url, present, h.host, undefined)
    expect(first.outcome).toBe('later')
    expect(await visit.kindOf(h.origin)).toBe('later')
    expect((await visit.run(h.origin, h.url, present, h.host)).outcome).toBe('later')
    expect((await visit.run(h.origin, h.url, present, otherTab(h))).outcome).toBe('later')
    expect(h.consent).toHaveBeenCalledTimes(1)
    expect(staged.discard).not.toHaveBeenCalled()
    expect(h.declined.has(h.origin)).toBe(false)
    expect(await grantsOf(h)).toEqual([])
  })

  it('drops a second visit from the tab that is already being asked: a reload or the page\'s own hint is the same visit', async () => {
    let answer = (_yes: boolean): void => {}
    const h = harness()
    h.consent.mockImplementation(async () => { h.events.push('ask'); return await new Promise<boolean>((resolve) => { answer = resolve }) })
    const visit = over(h)
    const first = visit.run(h.origin, h.url, present, h.host)
    await vi.waitFor(() => { expect(h.consent).toHaveBeenCalled() })
    expect((await visit.run(h.origin, h.url, present, { ...h.host, tab: () => ({ id: 'the-tab' }) })).outcome).toBe('duplicate')
    answer(true)
    expect((await first).outcome).toBe('entered')
    expect(h.consent).toHaveBeenCalledTimes(1)
  })

  it('leaves local files, loopback and developer origins, and an origin served from its partition, alone', async () => {
    const h = harness()
    expect(await over(h, { untouched: () => true }).kindOf(h.origin)).toBe('known')
    expect(await over(h, { servedFromCache: () => true }).kindOf(h.origin)).toBe('known')
  })

  it('serialises two visits to one origin and asks once: the second finds the app known', async () => {
    const h = harness()
    const visit = over(h)
    const [first, second] = await Promise.all([visit.run(h.origin, h.url, present, h.host), visit.run(h.origin, h.url, present, otherTab(h))])
    expect(first.outcome).toBe('entered')
    expect(['known', 'settling']).toContain(second.outcome)
    expect(h.consent).toHaveBeenCalledTimes(1)
  })

  it('tells a second visit that the first was answered no', async () => {
    const h = harness({ answer: false })
    const visit = over(h)
    const [first, second] = await Promise.all([visit.run(h.origin, h.url, present, h.host), visit.run(h.origin, h.url, present, otherTab(h))])
    expect(first).toMatchObject({ outcome: 'plain', why: 'denied' })
    expect(second.outcome).toBe('declined')
  })

  it('does not remember a block: the next visit is a first visit again, and asks again', async () => {
    const h = harness({ bundles: [bundle(VERIFIED, { declaration: DIFFERENT, content: CONTENT })] })
    const visit = over(h)
    const first = await visit.run(h.origin, h.url, present, h.host)
    if (first.outcome !== 'entered') throw new Error('expected an entry')
    expect(await first.background).toBe('blocked')
    await vi.waitFor(async () => { expect(await visit.kindOf(h.origin)).toBe('first') })
  })
})

