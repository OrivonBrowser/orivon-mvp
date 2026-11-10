import { afterEach, describe, expect, it, vi } from 'vitest'
import type { App } from 'electron'

// The preparer that runs before an app is served where websites run: it arms the guard on the origin's worker scripts, removes
// the workers a website left, and begins the origin's settling. Once the origin is served, the settling runs: the host is told,
// the website's open pages load again, and their leftovers go, before a worker's answer counts. The loader restores pinned apps at
// start-up through the same preparer, so it must be registered before that (`src/main/tests/subsystem-order.test.ts`).

const seen = vi.hoisted(() => ({
  preparer: undefined as undefined | ((appSession: unknown, origin: string, from: 'pin' | 'verifier') => Promise<void>),
  retired: undefined as undefined | ((origin: string) => void),
  events: [] as string[],
  settle: undefined as undefined | ((origin: string) => void),
  capable: true,
  failClear: false,
  pages: [] as unknown[],
  carry: new Set<string>(),
  entering: new Set<object>(),
  reloads: [] as string[]
}))
const forgotten = vi.hoisted(() => ({ origins: [] as string[] }))

vi.mock('electron', () => ({ session: { defaultSession: { id: 'default' }, fromPartition: (name: string) => ({ id: name }) } }))
vi.mock('../../../loader/electron/serve.js', () => ({
  beforeAppSessionServes: (preparer: typeof seen.preparer) => { seen.preparer = preparer },
  onAppOriginRetired: (listener: (origin: string) => void) => { seen.retired = listener }
}))
vi.mock('../../../loader/electron/carry-page.js', () => ({ isCarryPageUrl: (url: string) => seen.carry.has(url) }))
vi.mock('../../../loader/electron/app-partitions.js', () => ({
  servedOrigins: () => ['https://kept.eth'],
  onServingChange: () => {},
  AppNotReady: class AppNotReady extends Error {
    constructor (message: string, readonly advice: string, options?: { cause?: unknown }) { super(message, options) }
  }
}))
vi.mock('../../shell/app-session.js', () => ({ couldRunAsWebsite: () => seen.capable, runsAsWebsite: () => true }))
vi.mock('../../app-setup/pages-of-origin.js', () => ({ pagesOfOrigin: () => seen.pages }))
vi.mock('../../verifier/shell-serves.js', () => ({ servedKnownToHost: async () => { seen.events.push('host-knows') } }))
vi.mock('../session-attribution.js', () => ({ documentAnsweredByShell: (page: { ownDocument?: boolean }) => page.ownDocument === true }))
vi.mock('../stale-pages.js', () => ({
  forNewlyServed: (_deps: unknown, run: (origin: string) => void) => { seen.settle = run },
  isEnteringPage: (page: object) => seen.entering.has(page),
  reloadStalePage: (page: { url: string, emit: (event: string) => void }) => { seen.reloads.push(page.url); seen.events.push(`reload:${page.url}`); page.emit('did-navigate') }
}))
vi.mock('../../route/site-routes.js', () => ({ sitePartitionForOrigin: () => undefined }))
vi.mock('../../route/site-partition.js', () => ({ profilePartitionsHolding: () => [] }))
vi.mock('../website-workers.js', () => ({
  CLEARED_MARKS_DIRECTORY: 'website-workers-cleared-v2',
  LEGACY_CLEARED_MARKS_DIRECTORY: 'website-workers-cleared',
  forgetWebsiteWorkers: async (_where: unknown, origin: string) => { seen.events.push(`forget:${origin}`) },
  clearedOriginsInMemory: () => ({ has: () => false, add: () => {}, forget: (origin: string) => { forgotten.origins.push(origin) } }),
  clearedOriginsIn: () => ({ has: () => false, add: () => {}, forget: (origin: string) => { forgotten.origins.push(origin) } }),
  prepareWebsiteWorkers: async (_targets: unknown, origin: string, from: string) => {
    seen.events.push(`clear:${origin}:${from}:${refusesWorkerScript(script(origin)) ? 'guarded' : 'unguarded'}`)
    if (seen.failClear) throw new Error('storage busy')
  }
}))

const { websiteWorkersSubsystem } = await import('../website-workers-subsystem.js')
const { refusesWorkerScript, releaseWorkerScripts } = await import('../app-workers.js')
const { nextTick, resetSettlingForTests, workerAnswersTrusted } = await import('../worker-settle.js')
const { createSubsystemContext } = await import('../../registry.js')

const APP = 'https://kept.eth'
const script = (origin: string): Parameters<typeof refusesWorkerScript>[0] => ({ url: `${origin}/sw.js`, resourceType: 'script', hasPage: false, answeredByShell: false })
const ctx = (privateSession = false): ReturnType<typeof createSubsystemContext> => createSubsystemContext({ getPath: () => '/nonexistent/orivon-test-profile' } as unknown as App, privateSession)

interface FakePage { url: string, ownDocument: boolean, isDestroyed: () => boolean, getURL: () => string, on: (event: string, listener: () => void) => void, removeListener: (event: string, listener: () => void) => void, emit: (event: string) => void }
function pageAt (url: string, ownDocument = false): FakePage {
  const listeners = new Map<string, Set<() => void>>()
  return {
    url,
    ownDocument,
    isDestroyed: () => false,
    getURL: () => url,
    on: (event, listener) => { listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)) },
    removeListener: (event, listener) => { listeners.get(event)?.delete(listener) },
    emit: (event) => { for (const listener of [...(listeners.get(event) ?? [])]) listener() }
  }
}

afterEach(() => {
  resetSettlingForTests()
  seen.pages = []
  seen.carry.clear()
  seen.entering.clear()
  seen.reloads = []
  releaseWorkerScripts(APP)
  seen.events.length = 0
  forgotten.origins.length = 0
  seen.capable = true
  seen.failClear = false
})

describe('the website workers subsystem', () => {
  it('guards the origin\'s worker scripts before it removes the workers a website left', async () => {
    await websiteWorkersSubsystem.afterReady?.(ctx())
    await seen.preparer?.({}, APP, 'pin')
    expect(seen.events).toEqual([`clear:${APP}:pin:guarded`])
    expect(refusesWorkerScript(script(APP))).toBe(true)
  })

  it('does nothing for an origin that cannot run as a website', async () => {
    await websiteWorkersSubsystem.afterReady?.(ctx())
    seen.capable = false
    await seen.preparer?.({}, APP, 'verifier')
    expect(seen.events).toEqual([])
    expect(refusesWorkerScript(script(APP))).toBe(false)
  })

  it('stops the serving, and keeps the guard, when the website\'s workers cannot be removed', async () => {
    await websiteWorkersSubsystem.afterReady?.(ctx())
    seen.failClear = true
    await expect(seen.preparer?.({}, APP, 'pin')).rejects.toThrow(/workers a website of this address installed/)
    expect(refusesWorkerScript(script(APP))).toBe(true)
  })

  it('lifts the guard and forgets the clearing when the shell stops serving the origin', async () => {
    await websiteWorkersSubsystem.afterReady?.(ctx(true))
    await seen.preparer?.({}, APP, 'pin')
    seen.retired?.(APP)
    expect(refusesWorkerScript(script(APP))).toBe(false)
    expect(forgotten.origins).toEqual([APP])
  })

  it('counts no worker\'s answer as the app\'s until the origin has settled, and counts the answers after that', async () => {
    await websiteWorkersSubsystem.afterReady?.(ctx(true))
    await seen.preparer?.({}, APP, 'pin')
    expect(workerAnswersTrusted(APP, nextTick())).toBe(false)
    seen.settle?.(APP)
    await vi.waitFor(() => { expect(workerAnswersTrusted(APP, nextTick())).toBe(true) })
  })

  it('loads each website page again before it removes the workers and caches, and after the host knows', async () => {
    await websiteWorkersSubsystem.afterReady?.(ctx(true))
    await seen.preparer?.({}, APP, 'pin')
    seen.events.length = 0
    seen.pages = [pageAt(`${APP}/one`), pageAt(`${APP}/two`)]
    seen.settle?.(APP)
    await vi.waitFor(() => { expect(workerAnswersTrusted(APP, nextTick())).toBe(true) })
    expect(seen.events[0]).toBe('host-knows')
    expect(seen.events.slice(1, 3).sort()).toEqual([`reload:${APP}/one`, `reload:${APP}/two`])
    expect(seen.events.at(-1)).toBe(`forget:${APP}`)
  })

  it('leaves a page the shell answered, and the storage carry\'s hidden page, alone', async () => {
    await websiteWorkersSubsystem.afterReady?.(ctx(true))
    await seen.preparer?.({}, APP, 'pin')
    seen.events.length = 0
    const carry = `${APP}/carry`
    seen.carry.add(carry)
    seen.pages = [pageAt(`${APP}/app`, true), pageAt(carry)]
    seen.settle?.(APP)
    await vi.waitFor(() => { expect(workerAnswersTrusted(APP, nextTick())).toBe(true) })
    expect(seen.reloads).toEqual([])
    expect(seen.events).toEqual(['host-knows'])
  })

  it('waits for the page a first visit sends in to show the shell\'s document, then removes what the website wrote', async () => {
    await websiteWorkersSubsystem.afterReady?.(ctx(true))
    await seen.preparer?.({}, APP, 'pin')
    seen.events.length = 0
    const sentIn = pageAt(`${APP}/`)
    seen.entering.add(sentIn)
    seen.pages = [sentIn]
    seen.settle?.(APP)
    await vi.waitFor(() => { expect(seen.events).toEqual(['host-knows']) })
    expect(workerAnswersTrusted(APP, nextTick())).toBe(false)
    sentIn.ownDocument = true
    sentIn.emit('did-navigate')
    await vi.waitFor(() => { expect(workerAnswersTrusted(APP, nextTick())).toBe(true) })
    expect(seen.reloads).toEqual([])
    expect(seen.events).toEqual(['host-knows', `forget:${APP}`])
  })
})
