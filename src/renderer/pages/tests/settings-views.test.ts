import { describe, expect, it, vi } from 'vitest'
import { sizeWords } from '../settings/apps-view.js'
import { AppsState } from '../settings/apps-state.js'
import { PrivacyState } from '../settings/privacy-state.js'
import { UsageState } from '../settings/usage-state.js'
import { UpdatesState } from '../settings/updates-state.js'
import type { OrivonInternal } from '../shared/bridge.js'

describe('sizeWords', () => {
  it('reads a size as a person would', () => {
    expect(sizeWords(0)).toBe('0 bytes')
    expect(sizeWords(1023)).toBe('1023 bytes')
    expect(sizeWords(1024)).toBe('1.0 KB')
    expect(sizeWords(1536)).toBe('1.5 KB')
    expect(sizeWords(15 * 1024)).toBe('15 KB')
    expect(sizeWords(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(sizeWords(3 * 1024 ** 3)).toBe('3.0 GB')
    expect(sizeWords(5000 * 1024 ** 3)).toBe('5000 GB')
  })
})

function state (reply: unknown): { updates: UpdatesState, changes: number[] } {
  const changes: number[] = []
  const bridge = { request: async () => reply } as unknown as OrivonInternal
  return { updates: new UpdatesState(bridge, () => { changes.push(changes.length) }), changes }
}

describe('what "Check now" says', () => {
  it('is silent before anything is asked', () => {
    expect(state(undefined).updates.words()).toBe('')
  })

  it('says a newer release is there, and which', async () => {
    const { updates, changes } = state({ ok: true, answer: { reached: true, current: '1.0.0', latest: 'v1.1.0', newer: true, url: 'x' } })
    await updates.check()
    expect(updates.words()).toBe('v1.1.0 is available. You have 1.0.0.')
    expect(changes).toHaveLength(2)
  })

  it('says the person is up to date', async () => {
    const { updates } = state({ ok: true, answer: { reached: true, current: '1.1.0', latest: 'v1.1.0', newer: false, url: 'x' } })
    await updates.check()
    expect(updates.words()).toBe('You have the latest release (1.1.0).')
  })

  it('says when it could not reach the list, and when a private window is asked', async () => {
    const offline = state({ ok: true, answer: { reached: false, current: '1.0.0', latest: null, newer: false, url: null } })
    await offline.updates.check()
    expect(offline.updates.words()).toContain('Could not reach')
    const refused = state({ ok: false, reason: 'private' })
    await refused.updates.check()
    expect(refused.updates.words()).toContain('private window')
    const nothing = state(undefined)
    await nothing.updates.check()
    expect(nothing.updates.words()).toContain('private window')
  })

  it('takes another window\'s own check as an `updates.changed` push, without asking again', () => {
    const { updates, changes } = state(undefined)
    const answer = { reached: true, current: '1.0.0', latest: 'v1.1.0', newer: true, url: 'x' }

    expect(updates.handle('updates.changed', answer)).toBe(true)

    expect(updates.words()).toBe('v1.1.0 is available. You have 1.0.0.')
    expect(changes).toHaveLength(1)
  })

  it('ignores any other topic', () => {
    const { updates } = state(undefined)
    expect(updates.handle('settings.changed', {})).toBe(false)
    expect(updates.words()).toBe('')
  })
})

describe('AppsState.handle', () => {
  it('reloads the list on apps.changed', async () => {
    vi.useFakeTimers()
    let calls = 0
    const bridge = { request: async () => { calls += 1; return { apps: [], identity: 'not-started' } } } as unknown as OrivonInternal
    const apps = new AppsState(bridge, () => {})

    expect(apps.handle('apps.changed')).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)

    expect(calls).toBe(1)
    vi.useRealTimers()
  })

  it('coalesces a burst of apps.changed into one reload', async () => {
    vi.useFakeTimers()
    let calls = 0
    const bridge = { request: async () => { calls += 1; return { apps: [], identity: 'not-started' } } } as unknown as OrivonInternal
    const apps = new AppsState(bridge, () => {})

    apps.handle('apps.changed')
    apps.handle('apps.changed')
    apps.handle('apps.changed')
    await vi.advanceTimersByTimeAsync(1000)

    expect(calls).toBe(1)
    vi.useRealTimers()
  })

  it('ignores any other topic', () => {
    const bridge = { request: async () => { throw new Error('must not be called') } } as unknown as OrivonInternal
    expect(new AppsState(bridge, () => {}).handle('settings.changed')).toBe(false)
  })
})

describe('PrivacyState.handle', () => {
  it('reloads status and tells the page on privacy.changed', async () => {
    vi.useFakeTimers()
    let changes = 0
    const bridge = { request: async () => ({ history: { remembering: true, problem: null, count: 3 }, zoomSites: 1 }) } as unknown as OrivonInternal
    const privacy = new PrivacyState(bridge, () => { changes += 1 })

    expect(privacy.handle('privacy.changed')).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)

    expect(privacy.status).toEqual({ history: { remembering: true, problem: null, count: 3 }, zoomSites: 1 })
    expect(changes).toBe(1)
    vi.useRealTimers()
  })

  it('coalesces a burst of privacy.changed into one reload', async () => {
    vi.useFakeTimers()
    let calls = 0
    const bridge = { request: async () => { calls += 1; return { history: { remembering: true, problem: null, count: 0 }, zoomSites: 0 } } } as unknown as OrivonInternal
    const privacy = new PrivacyState(bridge, () => {})

    privacy.handle('privacy.changed')
    privacy.handle('privacy.changed')
    privacy.handle('privacy.changed')
    await vi.advanceTimersByTimeAsync(1000)

    expect(calls).toBe(1)
    vi.useRealTimers()
  })

  it('ignores any other topic', () => {
    const bridge = { request: async () => { throw new Error('must not be called') } } as unknown as OrivonInternal
    expect(new PrivacyState(bridge, () => {}).handle('settings.changed')).toBe(false)
  })
})

describe('PrivacyState.clear', () => {
  const STATUS = { history: { remembering: true, problem: null, count: 0 }, zoomSites: 0 }

  it('records ok, then refreshes status', async () => {
    let changes = 0
    const bridge = {
      request: async (domain: string, command: { type: string }) =>
        domain === 'privacy' && command.type === 'clear' ? { ok: true, failed: [] } : STATUS
    } as unknown as OrivonInternal
    const privacy = new PrivacyState(bridge, () => { changes += 1 })

    await privacy.clear({ history: 'all', siteData: false, cache: false, zoomLevels: false, appData: false })

    expect(privacy.lastClear).toEqual({ kind: 'ok' })
    expect(privacy.status).toEqual(STATUS)
    expect(changes).toBe(1)
  })

  it('records which kinds failed', async () => {
    const bridge = {
      request: async (domain: string, command: { type: string }) =>
        domain === 'privacy' && command.type === 'clear' ? { ok: false, failed: ['cache'] } : STATUS
    } as unknown as OrivonInternal
    const privacy = new PrivacyState(bridge, () => {})

    await privacy.clear({ history: 'none', siteData: false, cache: true, zoomLevels: false, appData: false })

    expect(privacy.lastClear).toEqual({ kind: 'failed', names: ['cache'] })
  })

  it('records a refusal when main sends back nothing', async () => {
    const bridge = { request: async () => undefined } as unknown as OrivonInternal
    const privacy = new PrivacyState(bridge, () => {})

    await privacy.clear({ history: 'none', siteData: false, cache: false, zoomLevels: false, appData: false })

    expect(privacy.lastClear).toEqual({ kind: 'refused' })
  })

  it('nothingChosen redraws without a request', () => {
    const bridge = { request: async () => { throw new Error('must not be called') } } as unknown as OrivonInternal
    let changes = 0
    const privacy = new PrivacyState(bridge, () => { changes += 1 })

    privacy.nothingChosen()

    expect(privacy.lastClear).toEqual({ kind: 'nothing-chosen' })
    expect(changes).toBe(1)
  })
})

describe('UsageState.handle', () => {
  it('reloads on usage.changed', async () => {
    let changes = 0
    const bridge = { request: async () => ({ private: false, consent: 'accepted', sent: [{ payload: {}, sentAtMs: 1 }] }) } as unknown as OrivonInternal
    const usage = new UsageState(bridge, () => { changes += 1 })

    expect(usage.handle('usage.changed')).toBe(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(usage.status?.sent).toEqual([{ payload: {}, sentAtMs: 1 }])
    expect(changes).toBe(1)
  })

  it('ignores any other topic', () => {
    const bridge = { request: async () => { throw new Error('must not be called') } } as unknown as OrivonInternal
    expect(new UsageState(bridge, () => {}).handle('settings.changed')).toBe(false)
  })
})
