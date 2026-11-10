import { afterEach, describe, expect, it, vi } from 'vitest'
import type { App } from 'electron'

// The preparer that runs before an app is served where websites run: it arms the guard on the origin's worker scripts, then
// removes the workers a website left. The loader restores pinned apps at start-up through the same preparer, so it must
// be registered before that (`src/main/tests/subsystem-order.test.ts`).

const seen = vi.hoisted(() => ({
  preparer: undefined as undefined | ((appSession: unknown, origin: string, from: 'pin' | 'verifier') => Promise<void>),
  retired: undefined as undefined | ((origin: string) => void),
  events: [] as string[],
  capable: true,
  failClear: false
}))
const forgotten = vi.hoisted(() => ({ origins: [] as string[] }))

vi.mock('electron', () => ({ session: { defaultSession: { id: 'default' }, fromPartition: (name: string) => ({ id: name }) } }))
vi.mock('../../../loader/electron/serve.js', () => ({
  beforeAppSessionServes: (preparer: typeof seen.preparer) => { seen.preparer = preparer },
  onAppOriginRetired: (listener: (origin: string) => void) => { seen.retired = listener }
}))
vi.mock('../../../loader/electron/app-partitions.js', () => ({
  AppNotReady: class AppNotReady extends Error {
    constructor (message: string, readonly advice: string, options?: { cause?: unknown }) { super(message, options) }
  }
}))
vi.mock('../../shell/app-session.js', () => ({ couldRunAsWebsite: () => seen.capable }))
vi.mock('../../route/site-routes.js', () => ({ sitePartitionForOrigin: () => undefined }))
vi.mock('../../route/site-partition.js', () => ({ profilePartitionsHolding: () => [] }))
vi.mock('../website-workers.js', () => ({
  clearedOriginsInMemory: () => ({ has: () => false, add: () => {}, forget: (origin: string) => { forgotten.origins.push(origin) } }),
  clearedOriginsIn: () => ({ has: () => false, add: () => {}, forget: (origin: string) => { forgotten.origins.push(origin) } }),
  prepareWebsiteWorkers: async (_targets: unknown, origin: string, from: string) => {
    seen.events.push(`clear:${origin}:${from}:${refusesWorkerScript(script(origin)) ? 'guarded' : 'unguarded'}`)
    if (seen.failClear) throw new Error('storage busy')
  }
}))

const { websiteWorkersSubsystem } = await import('../website-workers-subsystem.js')
const { refusesWorkerScript, releaseWorkerScripts } = await import('../app-workers.js')
const { createSubsystemContext } = await import('../../registry.js')

const APP = 'https://kept.eth'
const script = (origin: string): Parameters<typeof refusesWorkerScript>[0] => ({ url: `${origin}/sw.js`, resourceType: 'script', hasPage: false, answeredByShell: false })
const ctx = (privateSession = false): ReturnType<typeof createSubsystemContext> => createSubsystemContext({ getPath: () => '/nonexistent/orivon-test-profile' } as unknown as App, privateSession)

afterEach(() => {
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
})
