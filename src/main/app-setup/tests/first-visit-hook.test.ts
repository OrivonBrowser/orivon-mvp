import { describe, expect, it, vi } from 'vitest'
import type { OnBeforeRequestListenerDetails, WebContents } from 'electron'
import type { FirstVisit, FirstVisitResult, SetupHost } from '../../install/first-visit.js'
import { firstVisitBeforeRequest } from '../first-visit-hook.js'
import type { TabScreens } from '../tab-screens.js'

const URL_ = 'https://abc.ipfs.orivon/page'
const ORIGIN = 'https://abc.ipfs.orivon'
const CONTINUE = {}

function details (overrides: Record<string, unknown> = {}): OnBeforeRequestListenerDetails {
  return { id: 1, url: URL_, method: 'GET', resourceType: 'mainFrame', webContentsId: 7, timestamp: 0, ...overrides } as unknown as OnBeforeRequestListenerDetails
}

function screensFake (): TabScreens & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    blank: async () => { calls.push('blank') },
    sheet: async () => 'leave',
    end: () => { calls.push('end') },
    moved: () => false,
    signal: new AbortController().signal,
    tab: () => ({ window: {}, tabId: 't' }) as never,
    navigate: (url) => { calls.push(`navigate:${url}`) },
    leavePage: () => { calls.push('leavePage') },
    stop: () => { calls.push('stop') }
  }
}

function rig (options: { kind?: 'first' | 'declined' | 'known' | 'settling' | 'later', run?: (host: SetupHost) => Promise<FirstVisitResult>, screens?: boolean, contents?: boolean } = {}): { handler: ReturnType<typeof firstVisitBeforeRequest>, screens: ReturnType<typeof screensFake>, visit: FirstVisit, run: ReturnType<typeof vi.fn> } {
  const screens = screensFake()
  const run = vi.fn(async (_origin: string, _url: string, _caller: unknown, host: SetupHost, _signal?: AbortSignal): Promise<FirstVisitResult> => await (options.run ?? (async () => { host.plain(); return { outcome: 'plain', why: 'website' } }))(host))
  const visit: FirstVisit = { kindOf: vi.fn(async () => options.kind ?? 'first'), run: run as unknown as FirstVisit['run'], resume: async () => {} }
  const contents = { isDestroyed: () => false } as unknown as WebContents
  const handler = firstVisitBeforeRequest({
    firstVisit: () => visit,
    tabSetup: () => options.screens === false ? () => undefined : () => screens,
    contentsById: () => options.contents === false ? undefined : contents,
    windowForSender: () => undefined
  })
  return { handler, screens, visit, run }
}

describe('firstVisitBeforeRequest', () => {
  it('lets every request through that is not a tab\'s own top-level GET', async () => {
    const { handler, run } = rig()
    for (const odd of [{ resourceType: 'subFrame' }, { resourceType: 'script' }, { method: 'POST' }, { url: 'not a url' }]) {
      expect(await handler(details(odd), CONTINUE)).toBe(CONTINUE)
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('lets a request through for an origin that is not a first visit, without holding it', async () => {
    for (const kind of ['known', 'declined', 'settling', 'later'] as const) {
      const { handler, run } = rig({ kind })
      expect(await handler(details(), CONTINUE)).toBe(CONTINUE)
      expect(run).not.toHaveBeenCalled()
    }
  })

  it('lets a request through that no tab owns, or that the first visit is not wired for', async () => {
    expect(await rig({ contents: false }).handler(details(), CONTINUE)).toBe(CONTINUE)
    expect(await rig({ screens: false }).handler(details(), CONTINUE)).toBe(CONTINUE)
  })

  it('never holds the request: the page loads as an ordinary website while the visit runs beside it', async () => {
    let release: (() => void) | undefined
    const { handler, run, screens } = rig({ run: async (host) => { await new Promise<void>((resolve) => { release = resolve }); host.plain(); return { outcome: 'plain', why: 'denied' } } })
    expect(await handler(details(), CONTINUE)).toBe(CONTINUE)
    await vi.waitFor(() => { expect(run).toHaveBeenCalled() })
    // The visit has not ended, and nothing was done to the tab.
    expect(screens.calls).toEqual([])
    release?.()
    await vi.waitFor(() => { expect(screens.calls).toEqual(['end']) })
  })

  it('reloads the tab as the app when the visit lets it in', async () => {
    const { handler, screens } = rig({ run: async (host) => { host.enter(); return { outcome: 'entered', background: Promise.resolve('pinned' as const) } } })
    expect(await handler(details(), CONTINUE)).toBe(CONTINUE)
    await vi.waitFor(() => { expect(screens.calls).toEqual([`navigate:${URL_}`]) })
  })

  it('leaves the page where it is when the visit ends with the app not opened', async () => {
    const { handler, screens } = rig({ run: async (host) => { host.end(); return { outcome: 'blocked', differing: [] } } })
    expect(await handler(details(), CONTINUE)).toBe(CONTINUE)
    await vi.waitFor(() => { expect(screens.calls).toEqual(['end']) })
  })

  it('ends its screens and goes nowhere when the visit was a duplicate of one already asking in the tab, or was dismissed this run', async () => {
    for (const outcome of ['duplicate', 'later'] as const) {
      const { handler, screens } = rig({ run: async () => ({ outcome }) })
      expect(await handler(details(), CONTINUE)).toBe(CONTINUE)
      await vi.waitFor(() => { expect(screens.calls).toEqual(['end']) })
    }
  })

  it('goes into the app when another tab finished the visit first, and leaves a plain website when it was refused there', async () => {
    for (const outcome of ['known', 'settling'] as const) {
      const rigged = rig({ run: async () => ({ outcome }) })
      expect(await rigged.handler(details(), CONTINUE)).toBe(CONTINUE)
      await vi.waitFor(() => { expect(rigged.screens.calls).toEqual([`navigate:${URL_}`]) })
    }
    const declined = rig({ run: async () => ({ outcome: 'declined' }) })
    expect(await declined.handler(details(), CONTINUE)).toBe(CONTINUE)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(declined.screens.calls).toEqual([])
  })

  it('leaves the page an ordinary website when the visit itself fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { handler } = rig({ run: async () => { throw new Error('boom') } })
    expect(await handler(details(), CONTINUE)).toBe(CONTINUE)
    await vi.waitFor(() => { expect(error).toHaveBeenCalled() })
    error.mockRestore()
  })

  it('asks as the origin of the request, with the address being opened', async () => {
    const { handler, run } = rig()
    await handler(details(), CONTINUE)
    await vi.waitFor(() => { expect(run).toHaveBeenCalled() })
    expect(run.mock.calls[0]!.slice(0, 2)).toEqual([ORIGIN, URL_])
    expect(run.mock.calls[0]![4]).toBeInstanceOf(AbortSignal)
  })
})
