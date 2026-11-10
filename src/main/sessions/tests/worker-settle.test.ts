import { afterEach, describe, expect, it } from 'vitest'
import { beginSettling, forgetSettling, nextTick, resetSettlingForTests, retryDelayMs, settleAttempts, settledOrigin, settleServedOrigin, workerAnswersTrusted } from '../worker-settle.js'
import type { SettleDeps } from '../worker-settle.js'

// The order in which a served origin's workers become the app's: the host is told, the website's pages load again, the
// workers and caches they could have written go, and only then does a worker-answered document count.

const ORIGIN = 'https://kept.eth'
interface FakePage { readonly name: string, shell?: boolean, entering?: boolean }

function harness (pages: readonly FakePage[], over: Partial<SettleDeps<FakePage>> = {}): { deps: SettleDeps<FakePage>, events: string[] } {
  const events: string[] = []
  const deps: SettleDeps<FakePage> = {
    hostKnows: async () => { events.push('host-knows') },
    pagesOf: () => pages,
    isOwnDocument: (page) => page.shell === true,
    isEntering: (page) => page.entering === true,
    reload: async (page) => { events.push(`reload:${page.name}`) },
    becameOwn: async (page) => { events.push(`own:${page.name}`) },
    clear: async () => { events.push('clear') },
    limits: { hostMs: 40, pageMs: 40, enteringMs: 40, clearMs: 40 },
    log: () => {},
    ...over
  }
  return { deps, events }
}

afterEach(() => { resetSettlingForTests() })

describe('settling a served origin', () => {
  it('tells the host first, then loads the website pages again, then clears, and only then trusts a worker\'s answer', async () => {
    beginSettling(ORIGIN)
    const committedBefore = nextTick()
    const { deps, events } = harness([{ name: 'a' }, { name: 'b' }, { name: 'sent-in', entering: true }, { name: 'app', shell: true }])
    expect(workerAnswersTrusted(ORIGIN, nextTick())).toBe(false)
    expect(await settleServedOrigin(ORIGIN, deps)).toBe(true)
    expect(events[0]).toBe('host-knows')
    expect(events.slice(1, 4).sort()).toEqual(['own:sent-in', 'reload:a', 'reload:b'])
    expect(events[4]).toBe('clear')
    expect(events).toHaveLength(5)
    expect(workerAnswersTrusted(ORIGIN, committedBefore)).toBe(false)
    expect(workerAnswersTrusted(ORIGIN, nextTick())).toBe(true)
  })

  it('clears nothing, and trusts what committed while it ran, when no website page was open', async () => {
    beginSettling(ORIGIN)
    const during = nextTick()
    const { deps, events } = harness([{ name: 'app', shell: true }])
    expect(await settleServedOrigin(ORIGIN, deps)).toBe(true)
    expect(events).toEqual(['host-knows'])
    expect(workerAnswersTrusted(ORIGIN, during)).toBe(true)
  })

  it('clears what a website page wrote though the page is gone or has become the app\'s by the time the host has been heard', async () => {
    beginSettling(ORIGIN)
    let pages: readonly FakePage[] = [{ name: 'sent-in', entering: true }, { name: 'closed' }]
    const { deps, events } = harness([], { pagesOf: () => pages, hostKnows: async () => { events.push('host-knows'); pages = [{ name: 'sent-in', shell: true }] } })
    expect(await settleServedOrigin(ORIGIN, deps)).toBe(true)
    expect(events).toEqual(['host-knows', 'clear'])
    expect(workerAnswersTrusted(ORIGIN, nextTick())).toBe(true)
  })

  it('remembers a website page across attempts: the attempt that settles clears for a page an earlier one saw', async () => {
    beginSettling(ORIGIN)
    let pages: readonly FakePage[] = [{ name: 'gap' }]
    let told = false
    const { deps, events } = harness([], { pagesOf: () => pages, hostKnows: async () => { if (!told) await new Promise(() => {}) } })
    expect(await settleServedOrigin(ORIGIN, deps)).toBe(false)
    pages = []
    told = true
    expect(await settleServedOrigin(ORIGIN, deps)).toBe(true)
    expect(events).toEqual(['clear'])
  })

  it('does not load a page the shell answered again, and counts only the others as the website\'s', async () => {
    beginSettling(ORIGIN)
    const { deps, events } = harness([{ name: 'app', shell: true }, { name: 'gap' }])
    await settleServedOrigin(ORIGIN, deps)
    expect(events).toEqual(['host-knows', 'reload:gap', 'clear'])
  })

  it('leaves the origin untrusted when the host does not say it was told, and settles once a later attempt hears it', async () => {
    beginSettling(ORIGIN)
    let told = false
    const { deps, events } = harness([{ name: 'gap' }], { hostKnows: async () => { if (!told) await new Promise(() => {}) } })
    expect(await settleServedOrigin(ORIGIN, deps)).toBe(false)
    expect(events).toEqual([])
    expect(workerAnswersTrusted(ORIGIN, nextTick())).toBe(false)
    expect(await settledOrigin(ORIGIN, 1)).toBe(false)
    expect(settleAttempts(ORIGIN)).toBe(1)
    told = true
    expect(await settleServedOrigin(ORIGIN, deps)).toBe(true)
    expect(events).toEqual(['reload:gap', 'clear'])
    expect(workerAnswersTrusted(ORIGIN, nextTick())).toBe(true)
  })

  it.each([
    ['a page that does not load again', { reload: async () => await new Promise<void>(() => {}) }],
    ['a page being sent in that never shows the shell\'s document', { becameOwn: async () => await new Promise<void>(() => {}) }],
    ['a removal that does not end', { clear: async () => await new Promise<void>(() => {}) }],
    ['a removal that fails', { clear: async () => { throw new Error('storage busy') } }]
  ] as const)('stays untrusted for %s', async (_what, over) => {
    beginSettling(ORIGIN)
    const { deps } = harness([{ name: 'gap' }, { name: 'sent-in', entering: true }], over as Partial<SettleDeps<FakePage>>)
    expect(await settleServedOrigin(ORIGIN, deps)).toBe(false)
    expect(workerAnswersTrusted(ORIGIN, nextTick())).toBe(false)
  })

  it('answers whether an origin has settled, waiting up to the bound for it to', async () => {
    beginSettling(ORIGIN)
    const waiting = settledOrigin(ORIGIN, 1_000)
    await settleServedOrigin(ORIGIN, harness([]).deps)
    expect(await waiting).toBe(true)
    expect(await settledOrigin(ORIGIN, 1)).toBe(true)
  })

  it('says no once the bound has passed without the origin settling, and yes if a later attempt settles it in time', async () => {
    beginSettling(ORIGIN)
    expect(await settledOrigin(ORIGIN, 10)).toBe(false)
    const waiting = settledOrigin(ORIGIN, 1_000)
    await settleServedOrigin(ORIGIN, harness([]).deps)
    expect(await waiting).toBe(true)
  })

  it('trusts nothing for an origin it was never asked to settle, or one that stopped being served', async () => {
    expect(workerAnswersTrusted(ORIGIN, nextTick())).toBe(false)
    beginSettling(ORIGIN)
    await settleServedOrigin(ORIGIN, harness([]).deps)
    expect(workerAnswersTrusted(ORIGIN, nextTick())).toBe(true)
    forgetSettling(ORIGIN)
    expect(workerAnswersTrusted(ORIGIN, nextTick())).toBe(false)
    expect(await settledOrigin(ORIGIN, 1)).toBe(false)
  })

  it('judges an origin by the origin of its address, however it is spelled', async () => {
    beginSettling('https://Kept.ETH:443/')
    await settleServedOrigin(ORIGIN, harness([]).deps)
    expect(workerAnswersTrusted('https://kept.eth', nextTick())).toBe(true)
    expect(workerAnswersTrusted('https://other.eth', nextTick())).toBe(false)
  })

  it('begins again when the shell serves the origin again, so documents of the earlier serving are not trusted', async () => {
    beginSettling(ORIGIN)
    await settleServedOrigin(ORIGIN, harness([]).deps)
    const earlier = nextTick()
    beginSettling(ORIGIN)
    expect(workerAnswersTrusted(ORIGIN, earlier)).toBe(false)
  })

  it('runs one attempt at a time', async () => {
    beginSettling(ORIGIN)
    const { deps, events } = harness([{ name: 'gap' }], { reload: async (page) => { events.push(`reload:${page.name}`); await new Promise((resolve) => setTimeout(resolve, 10)) } })
    const [first, second] = await Promise.all([settleServedOrigin(ORIGIN, deps), settleServedOrigin(ORIGIN, deps)])
    expect([first, second].filter(Boolean)).toHaveLength(1)
    expect(events.filter((event) => event === 'clear')).toHaveLength(1)
  })
})

describe('retryDelayMs', () => {
  it('doubles from three seconds to a minute and stays there, so an origin whose host is slow is tried for as long as it is served without the tries crowding the host', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(retryDelayMs)).toEqual([3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000])
  })
})
