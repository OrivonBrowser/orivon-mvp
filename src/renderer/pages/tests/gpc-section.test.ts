import { describe, expect, it, vi } from 'vitest'
import { privacyNetworkRows } from '../settings/sections/privacy-network.js'
import { SettingsState } from '../settings/state.js'
import type { OrivonInternal } from '../shared/bridge.js'
import type { Row } from '../settings/model.js'

const KEY = 'privacy.globalPrivacyControl'

async function loaded (value: boolean, atStart: boolean, isPrivate = false): Promise<{ state: SettingsState, request: ReturnType<typeof vi.fn> }> {
  const request = vi.fn(async (domain: string) => {
    if (domain === 'settings') return await Promise.resolve({ descriptions: [], values: { [KEY]: value }, atStart: { [KEY]: atStart } })
    if (domain === 'profiles') return await Promise.resolve({ profiles: [], isPrivate })
    return await Promise.resolve({})
  })
  const state = new SettingsState({ request, onEvent: () => () => {} } as unknown as OrivonInternal, [])
  await state.load()
  return { state, request }
}

const row = (id: string): Row => privacyNetworkRows.find((candidate) => candidate.id === id) as Row

describe('the Global Privacy Control rows', () => {
  it('say what the signal asks, and the header and property it sets', () => {
    const help = row('global-privacy-control').help ?? ''
    expect(help).toContain('asks sites not to sell or share your data')
    expect(help).toContain('California')
    expect(help).toContain('Sec-GPC: 1')
    expect(help).toContain('navigator.globalPrivacyControl')
  })

  it('offer a restart only once the choice differs from the one this process started with', async () => {
    expect(row('global-privacy-control-restart').visible?.((await loaded(true, true)).state)).toBe(false)
    expect(row('global-privacy-control-restart').visible?.((await loaded(false, true)).state)).toBe(true)
    expect(row('global-privacy-control-restart').visible?.((await loaded(true, false)).state)).toBe(true)
  })

  it('offer no restart in a private window, and grey the switch out there', async () => {
    const { state } = await loaded(false, true, true)
    expect(row('global-privacy-control-restart').visible?.(state)).toBe(false)
    const control = row('global-privacy-control').control
    expect(control.type === 'toggle' && control.disabled?.(state)).toBe(true)
  })

  it('ask the application to start again', async () => {
    const { state, request } = await loaded(false, true)
    const control = row('global-privacy-control-restart').control
    if (control.type !== 'action') throw new Error('not an action')
    await control.run(state)
    expect(request).toHaveBeenCalledWith('app', { type: 'relaunch' })
  })
})
