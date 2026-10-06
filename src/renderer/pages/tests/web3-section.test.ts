import { describe, expect, it, vi } from 'vitest'
import { web3 } from '../settings/sections/web3.js'
import { SettingsState } from '../settings/state.js'
import type { OrivonInternal } from '../shared/bridge.js'
import type { Row } from '../settings/model.js'

const SUMMARY = 'Switched off. No .eth name can be verified, so none loads.'

function stateWith (status: { forcedOff: boolean, enabledAtStart: boolean } | null, chosen = true): SettingsState {
  const bridge = { request: vi.fn(async () => await Promise.resolve(undefined)), onEvent: () => () => {} } as unknown as OrivonInternal
  const state = new SettingsState(bridge)
  state.web3.status = status === null ? null : { ...status, enabled: false, view: { state: 'off', summary: SUMMARY, checkpoint: '', about: '', endpoints: [] } } as unknown as typeof state.web3.status
  vi.spyOn(state, 'value').mockImplementation((key: string) => (key === 'web3.lightClient' ? chosen : undefined))
  return state
}

const row = (id: string): Row => web3.rows.find((candidate) => candidate.id === id) as Row

describe('the Web3 section while the light client is forced off for the run', () => {
  it('disables the switch, so it shows off instead of contradicting the row that says off', () => {
    const control = row('web3-light-client').control
    expect(control.type === 'toggle' && control.disabled?.(stateWith({ forcedOff: true, enabledAtStart: false }))).toBe(true)
    expect(row('web3-forced-off').visible?.(stateWith({ forcedOff: true, enabledAtStart: false }))).toBe(true)
  })

  it('offers no restart, since a restart inherits the switch and would not apply the choice', () => {
    expect(row('web3-restart').visible?.(stateWith({ forcedOff: true, enabledAtStart: false }, true))).toBe(false)
  })

  it('leaves the switch live and the restart row to the choice when the run is not forced off', () => {
    const state = stateWith({ forcedOff: false, enabledAtStart: true }, false)
    const control = row('web3-light-client').control
    expect(control.type === 'toggle' && control.disabled?.(state)).toBe(false)
    expect(row('web3-forced-off').visible?.(state)).toBe(false)
    expect(row('web3-restart').visible?.(state)).toBe(true)
  })
})

describe('the light client state row', () => {
  it('says the sentence main gives, never the machine word in front of it', () => {
    const control = row('web3-state').control
    const text = control.type === 'info' ? control.text(stateWith({ forcedOff: false, enabledAtStart: true })) : ''
    expect(text).toBe(SUMMARY)
    expect(text).not.toMatch(/^[a-z]+: /)
  })

  it('is empty until the status has arrived', () => {
    const control = row('web3-state').control
    expect(control.type === 'info' && control.text(stateWith(null))).toBe('')
  })
})

describe('the gateway redirect row', () => {
  it('is a toggle on its own setting, always shown and always usable', () => {
    const candidate = row('web3-eth-gateway')
    expect(candidate.control.type === 'toggle' && candidate.control.key).toBe('web3.ethGatewayRedirect')
    for (const status of [null, { forcedOff: true, enabledAtStart: false }, { forcedOff: false, enabledAtStart: true }]) {
      const state = stateWith(status)
      expect(candidate.visible?.(state) ?? true).toBe(true)
      expect(candidate.control.type === 'toggle' && (candidate.control.disabled?.(state) ?? false)).toBe(false)
    }
  })

  it('sits after the forced-off row', () => {
    const ids = web3.rows.map((candidate) => candidate.id)
    expect(ids.indexOf('web3-eth-gateway')).toBe(ids.indexOf('web3-forced-off') + 1)
  })
})
