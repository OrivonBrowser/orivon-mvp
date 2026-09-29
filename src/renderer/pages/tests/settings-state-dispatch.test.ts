// SettingsState.load()'s onEvent dispatch: every topic a store publishes
// (apps.changed, privacy.changed, usage.changed, updates.changed,
// profiles.changed, plus the pre-existing shortcuts/web3/settings ones)
// reaches its own sub-state and nowhere else, and the page is told to redraw.
import { describe, expect, it, vi } from 'vitest'
import { SettingsState } from '../settings/state.js'
import type { OrivonInternal } from '../shared/bridge.js'

const REPLIES: Record<string, unknown> = {
  settings: { descriptions: [], values: {} },
  about: { version: '1.0.0', electron: '1', chromium: '1', node: '1', platform: 'linux', userAgent: 'x', developerMode: false },
  shortcuts: { platform: 'linux', rows: [] },
  privacy: { history: { remembering: true, problem: null, count: 0 }, zoomSites: 0 },
  web3: { view: { state: 'off' }, enabled: false, enabledAtStart: false, forcedOff: false },
  profiles: { profiles: [{ id: 'default', name: 'Default', current: true }], isPrivate: false },
  apps: { apps: [], identity: 'not-started' },
  telemetry: { private: false, consent: 'undecided' }
}

async function loadedState (replies: Record<string, unknown> = REPLIES): Promise<{ state: SettingsState, fire: (topic: string, payload?: unknown) => void }> {
  let handler: ((topic: string, payload: unknown) => void) | undefined
  const bridge = {
    request: async (domain: string, _command: unknown) => replies[domain],
    onEvent: (listener: (topic: string, payload: unknown) => void) => { handler = listener; return () => {} }
  } as unknown as OrivonInternal
  const state = new SettingsState(bridge)
  await state.load()
  return { state, fire: (topic, payload) => { handler?.(topic, payload) } }
}

describe('SettingsState dispatch', () => {
  it('routes apps.changed to AppsState alone', async () => {
    vi.useFakeTimers()
    const { state, fire } = await loadedState()
    const otherLoad = vi.spyOn(state.privacy, 'load')

    fire('apps.changed')
    await vi.advanceTimersByTimeAsync(1000)

    expect(otherLoad).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('routes privacy.changed to PrivacyState and redraws', async () => {
    vi.useFakeTimers()
    const { state, fire } = await loadedState()
    let notified = 0
    state.onChange(() => { notified += 1 })

    fire('privacy.changed')
    await vi.advanceTimersByTimeAsync(1000)

    expect(notified).toBe(1)
    vi.useRealTimers()
  })

  it('routes usage.changed to UsageState and redraws', async () => {
    const { state, fire } = await loadedState()
    let notified = 0
    state.onChange(() => { notified += 1 })

    fire('usage.changed')
    await Promise.resolve()
    await Promise.resolve()

    expect(notified).toBe(1)
  })

  it('routes updates.changed to UpdatesState with its payload', async () => {
    const { state, fire } = await loadedState()
    let notified = 0
    state.onChange(() => { notified += 1 })
    const answer = { reached: true, current: '1.0.0', latest: 'v1.1.0', newer: true, url: 'x' }

    fire('updates.changed', answer)

    expect(state.updates.words()).toBe('v1.1.0 is available. You have 1.0.0.')
    expect(notified).toBe(1)
  })

  it('reloads the profiles list on profiles.changed', async () => {
    vi.useFakeTimers()
    let profileCalls = 0
    let handler: ((topic: string, payload: unknown) => void) | undefined
    const names = ['Default', 'Renamed']
    const bridge = {
      request: async (domain: string) => domain === 'profiles' ? { profiles: [{ id: 'default', name: names[profileCalls++], current: true }], isPrivate: false } : REPLIES[domain],
      onEvent: (listener: (topic: string, payload: unknown) => void) => { handler = listener; return () => {} }
    } as unknown as OrivonInternal
    const state = new SettingsState(bridge)
    await state.load()
    expect(state.profiles?.profiles[0]?.name).toBe('Default')

    handler?.('profiles.changed', undefined)
    await vi.advanceTimersByTimeAsync(1000)

    expect(state.profiles?.profiles[0]?.name).toBe('Renamed')
    vi.useRealTimers()
  })

  it('coalesces a burst of profiles.changed into one reload', async () => {
    vi.useFakeTimers()
    let profileCalls = 0
    let handler: ((topic: string, payload: unknown) => void) | undefined
    const bridge = {
      request: async (domain: string) => domain === 'profiles' ? { profiles: [], isPrivate: false, call: profileCalls++ } : REPLIES[domain],
      onEvent: (listener: (topic: string, payload: unknown) => void) => { handler = listener; return () => {} }
    } as unknown as OrivonInternal
    const state = new SettingsState(bridge)
    await state.load()
    const before = profileCalls

    handler?.('profiles.changed', undefined)
    handler?.('profiles.changed', undefined)
    handler?.('profiles.changed', undefined)
    await vi.advanceTimersByTimeAsync(1000)

    expect(profileCalls - before).toBe(1)
    vi.useRealTimers()
  })

  it('still handles settings.changed exactly as before', async () => {
    const { state, fire } = await loadedState()

    fire('settings.changed', { key: 'some.key', value: 42 })

    expect(state.value('some.key')).toBe(42)
  })
})
