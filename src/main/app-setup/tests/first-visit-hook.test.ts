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
    show: () => { calls.push('show') },
    sheet: async () => 'leave',
    end: () => { calls.push('end') },
    moved: () => false,
    navigate: (url) => { calls.push(`navigate:${url}`) },
    leavePage: () => { calls.push('leavePage') }
  }
}

function rig (options: { kind?: 'first' | 'declined' | 'known', run?: (host: SetupHost) => Promise<FirstVisitResult>, screens?: boolean, contents?: boolean } = {}): { handler: ReturnType<typeof firstVisitBeforeRequest>, screens: ReturnType<typeof screensFake>, visit: FirstVisit, run: ReturnType<typeof vi.fn> } {
  const screens = screensFake()
  const run = vi.fn(async (_origin: string, _url: string, _caller: unknown, host: SetupHost): Promise<FirstVisitResult> => await (options.run ?? (async () => { host.plain(); return { outcome: 'plain', why: 'website' } }))(host))
  const visit: FirstVisit = { kindOf: vi.fn(async () => options.kind ?? 'first'), run: run as unknown as FirstVisit['run'] }
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
    for (const kind of ['known', 'declined'] as const) {
      const { handler, run } = rig({ kind })
      expect(await handler(details(), CONTINUE)).toBe(CONTINUE)
      expect(run).not.toHaveBeenCalled()
    }
  })

  it('lets a request through that no tab owns, or that the first visit is not wired for', async () => {
    expect(await rig({ contents: false }).handler(details(), CONTINUE)).toBe(CONTINUE)
    expect(await rig({ screens: false }).handler(details(), CONTINUE)).toBe(CONTINUE)
  })

  it('holds the request while the visit runs, and lets it go on when the site opens as a plain website', async () => {
    let release: (() => void) | undefined
    const { handler, screens } = rig({ run: async (host) => { await new Promise<void>((resolve) => { release = resolve }); host.plain(); return { outcome: 'plain', why: 'denied' } } })
    let settled = false
    const held = handler(details(), CONTINUE).then((response) => { settled = true; return response })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    release?.()
    expect(await held).toBe(CONTINUE)
    expect(screens.calls).toEqual(['end'])
  })

  it('cancels the request and takes the tab into the app when the files are in', async () => {
    const { handler, screens } = rig({ run: async (host) => { host.enter(); return { outcome: 'entered', installed: {} as never } } })
    expect(await handler(details(), CONTINUE)).toEqual({ cancel: true })
    expect(screens.calls).toEqual(['end', `navigate:${URL_}`])
  })

  it('cancels the request when the visit ends with the app not opened', async () => {
    const { handler, screens } = rig({ run: async (host) => { host.end(); return { outcome: 'blocked', differing: [] } } })
    expect(await handler(details(), CONTINUE)).toEqual({ cancel: true })
    expect(screens.calls).toEqual(['end'])
  })

  it('goes into the app when another tab finished the visit first, and opens a plain website when it was refused there', async () => {
    const known = rig({ run: async () => ({ outcome: 'known' }) })
    expect(await known.handler(details(), CONTINUE)).toEqual({ cancel: true })
    expect(known.screens.calls).toEqual(['end', `navigate:${URL_}`])
    const declined = rig({ run: async () => ({ outcome: 'declined' }) })
    expect(await declined.handler(details(), CONTINUE)).toBe(CONTINUE)
  })

  it('lets the request go on as an ordinary page when the visit itself fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { handler } = rig({ run: async () => { throw new Error('boom') } })
    expect(await handler(details(), CONTINUE)).toBe(CONTINUE)
    error.mockRestore()
  })

  it('does not answer twice when the host is used and the visit then returns', async () => {
    const { handler } = rig({ run: async (host) => { host.plain(); host.end(); return { outcome: 'plain', why: 'website' } } })
    expect(await handler(details(), CONTINUE)).toBe(CONTINUE)
  })

  it('asks as the origin of the request, with the address being opened', async () => {
    const { handler, run } = rig()
    await handler(details(), CONTINUE)
    expect(run.mock.calls[0]!.slice(0, 2)).toEqual([ORIGIN, URL_])
  })
})
