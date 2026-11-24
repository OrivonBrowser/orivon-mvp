// `resumePausedWorkers` and `visitAfterRelaunch` against fake contents and pages: no Electron is launched. The worker a DevTools
// client holds at its start is a race inside the test driver that a launch hits in a few runs of a hundred, so what the helpers do
// about it is proved here, where it can be made to happen every time.
import type { ElectronApplication, Page } from 'playwright'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { clickAddressBarRetrying, waitForTab, findViewShowing } = vi.hoisted(() => ({
  clickAddressBarRetrying: vi.fn(),
  waitForTab: vi.fn(),
  findViewShowing: vi.fn()
}))
vi.mock('./launch-electron.mjs', () => ({ launchElectron: vi.fn() }))
vi.mock('./e2e-helpers.js', () => ({ clickAddressBarRetrying }))
vi.mock('./smoke-helpers.mjs', async (importOriginal) => ({ ...await importOriginal<typeof import('./smoke-helpers.mjs')>(), waitForTab, findViewShowing }))

const { resumePausedWorkers, visitAfterRelaunch } = await import('./qa-helpers.js')

interface FakeTarget { targetId: string, type: string }

/** A contents whose debugger records every call; `attached` says whether another client holds it. */
function fakeContents (calls: string[], targets: FakeTarget[], attached = false, name = 'contents'): { isDestroyed: () => boolean, debugger: Record<string, unknown> } {
  let held = attached
  return {
    isDestroyed: () => false,
    debugger: {
      isAttached: () => held,
      attach: (version: string) => { calls.push(`${name}: attach ${version}`); held = true },
      detach: () => { calls.push(`${name}: detach`); held = false },
      sendCommand: async (method: string, params?: { targetId?: string, sessionId?: string }, sessionId?: string) => {
        const about = params?.targetId ?? params?.sessionId
        calls.push(`${name}: ${method}${about === undefined ? '' : ` ${about}`}${sessionId === undefined ? '' : ` in ${sessionId}`}`)
        if (method === 'Target.getTargets') return { targetInfos: targets }
        if (method === 'Target.attachToTarget') return { sessionId: `session-of-${params?.targetId ?? ''}` }
        return {}
      }
    }
  }
}

/** An application whose `evaluate` runs the callback against `webContents`, as Electron's main process would. */
function appWith (contents: unknown[]): ElectronApplication {
  return { evaluate: async (callback: (electron: unknown) => unknown) => await callback({ webContents: { getAllWebContents: () => contents } }) } as unknown as ElectronApplication
}

describe('resumePausedWorkers', () => {
  it('asks every service worker target to go on, through a debugger it opens and closes again', async () => {
    const calls: string[] = []
    const contents = fakeContents(calls, [{ targetId: 'page-1', type: 'page' }, { targetId: 'worker-1', type: 'service_worker' }, { targetId: 'worker-2', type: 'service_worker' }])
    expect(await resumePausedWorkers(appWith([contents]))).toBe(2)
    expect(calls).toEqual([
      'contents: attach 1.3',
      'contents: Target.getTargets',
      'contents: Target.attachToTarget worker-1',
      'contents: Runtime.runIfWaitingForDebugger in session-of-worker-1',
      'contents: Target.detachFromTarget session-of-worker-1',
      'contents: Target.attachToTarget worker-2',
      'contents: Runtime.runIfWaitingForDebugger in session-of-worker-2',
      'contents: Target.detachFromTarget session-of-worker-2',
      'contents: detach'
    ])
  })

  it('lets go of its own debugger when there is no worker to resume', async () => {
    const calls: string[] = []
    expect(await resumePausedWorkers(appWith([fakeContents(calls, [{ targetId: 'page-1', type: 'page' }])]))).toBe(0)
    expect(calls).toEqual(['contents: attach 1.3', 'contents: Target.getTargets', 'contents: detach'])
  })

  it('prefers a contents nobody holds, and never detaches one a client already holds', async () => {
    const calls: string[] = []
    const held = fakeContents(calls, [], true, 'held')
    const free = fakeContents(calls, [{ targetId: 'worker-1', type: 'service_worker' }], false, 'free')
    expect(await resumePausedWorkers(appWith([held, free]))).toBe(1)
    expect(calls.every((call) => call.startsWith('free:'))).toBe(true)

    const onlyHeld: string[] = []
    expect(await resumePausedWorkers(appWith([fakeContents(onlyHeld, [{ targetId: 'worker-1', type: 'service_worker' }], true, 'held')]))).toBe(1)
    expect(onlyHeld).not.toContain('held: attach 1.3')
    expect(onlyHeld).not.toContain('held: detach')
  })

  it('does nothing when the application has no contents', async () => {
    expect(await resumePausedWorkers(appWith([]))).toBe(0)
  })

  it('closes its debugger when a command fails, and reports the failure', async () => {
    const calls: string[] = []
    const contents = fakeContents(calls, [{ targetId: 'worker-1', type: 'service_worker' }])
    const send = contents.debugger['sendCommand'] as (method: string) => Promise<unknown>
    contents.debugger['sendCommand'] = async (method: string, ...rest: unknown[]) => {
      if (method === 'Target.attachToTarget') throw new Error('the target is gone')
      return await (send as (...args: unknown[]) => Promise<unknown>)(method, ...rest)
    }
    await expect(resumePausedWorkers(appWith([contents]))).rejects.toThrow('the target is gone')
    expect(calls.at(-1)).toBe('contents: detach')
  })
})

describe('visitAfterRelaunch', () => {
  const chrome = {} as Page
  const view = { waitForLoadState: vi.fn(async () => {}) }
  const URL = 'https://app.orivon.test/'

  beforeEach(() => {
    clickAddressBarRetrying.mockReset()
    waitForTab.mockReset()
    findViewShowing.mockReset().mockReturnValue(view)
  })

  it('types the address once and does not touch a debugger when the tab arrives', async () => {
    waitForTab.mockResolvedValueOnce({ ok: true })
    const evaluate = vi.fn()
    expect(await visitAfterRelaunch({ evaluate } as unknown as ElectronApplication, chrome, URL)).toBe(view)
    expect(clickAddressBarRetrying).toHaveBeenCalledTimes(1)
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('lets the held workers go, without typing again, when the tab has not arrived after a short wait', async () => {
    waitForTab.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true })
    const calls: string[] = []
    const app = appWith([fakeContents(calls, [{ targetId: 'worker-1', type: 'service_worker' }])])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await visitAfterRelaunch(app, chrome, URL)).toBe(view)
      expect(warn.mock.calls.flat().join(' ')).toContain('asked 1 service worker(s) to go on')
    } finally {
      warn.mockRestore()
    }
    expect(clickAddressBarRetrying).toHaveBeenCalledTimes(1)
    expect(calls).toContain('contents: Runtime.runIfWaitingForDebugger in session-of-worker-1')
    expect(waitForTab.mock.calls[0]?.[2], 'the first wait is the short one').toBeLessThan(8_000)
    expect(waitForTab.mock.calls[1]?.[2], 'the second wait is the full one').toBeUndefined()
  })

  it('fails when the tab still has not arrived once the workers are let go', async () => {
    waitForTab.mockResolvedValue({ ok: false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(visitAfterRelaunch(appWith([fakeContents([], [])]), chrome, URL)).rejects.toThrow()
    } finally {
      warn.mockRestore()
    }
  })
})
