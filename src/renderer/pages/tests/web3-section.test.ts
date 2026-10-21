import { describe, expect, it, vi } from 'vitest'
import { web3 } from '../settings/sections/web3.js'
import { SettingsState } from '../settings/state.js'
import type { OrivonInternal } from '../shared/bridge.js'
import type { Row } from '../settings/model.js'

const SUMMARY = 'Switched off. No .eth name can be verified, so none loads.'

function stateWith (status: { forcedOff: boolean } | null, chosen = true): SettingsState {
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
    expect(control.type === 'toggle' && control.disabled?.(stateWith({ forcedOff: true }))).toBe(true)
    expect(row('web3-forced-off').visible?.(stateWith({ forcedOff: true }))).toBe(true)
  })

  it('leaves the switch live when the run is not forced off, and has no restart row: a change applies at once', () => {
    const state = stateWith({ forcedOff: false }, false)
    const control = row('web3-light-client').control
    expect(control.type === 'toggle' && control.disabled?.(state)).toBe(false)
    expect(row('web3-forced-off').visible?.(state)).toBe(false)
    expect(web3.rows.map((candidate) => candidate.id)).not.toContain('web3-restart')
  })
})

describe('the light client state row', () => {
  it('says the sentence main gives, never the machine word in front of it', () => {
    const control = row('web3-state').control
    const text = control.type === 'info' ? control.text(stateWith({ forcedOff: false })) : ''
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
    for (const status of [null, { forcedOff: true }, { forcedOff: false }]) {
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

describe('the IPFS rows', () => {
  function withSource (source: string, view: unknown = undefined): SettingsState {
    const state = stateWith({ forcedOff: false })
    vi.spyOn(state, 'value').mockImplementation((key: string) => (key === 'web3.ipfsSource' ? source : undefined))
    if (view !== undefined) (state.web3.status as unknown as { view: unknown }).view = view
    return state
  }

  it('offers the choice of source on its own setting, always shown', () => {
    const candidate = row('web3-ipfs-source')
    expect(candidate.label).toBe('Load IPFS sites from')
    expect(candidate.control.type === 'choice' && candidate.control.key).toBe('web3.ipfsSource')
    expect(candidate.visible?.(withSource('node')) ?? true).toBe(true)
  })

  it('shows the lookup service switch only while the source is the node', () => {
    const candidate = row('web3-ipfs-lookup')
    expect(candidate.label).toBe('Use a lookup service to find IPFS sites faster')
    expect(candidate.control.type === 'toggle' && candidate.control.key).toBe('web3.ipfsLookupService')
    expect(candidate.visible?.(withSource('node'))).toBe(true)
    expect(candidate.visible?.(withSource('gateways'))).toBe(false)
  })

  it('says in a sentence what the lookup service learns', () => {
    expect(row('web3-ipfs-lookup').help).toMatch(/learn which sites you look up/)
  })

  it('shows the node\'s state only when main reports one, in the sentence main gives', () => {
    const candidate = row('web3-ipfs-node')
    expect(candidate.visible?.(withSource('node'))).toBe(false)
    const state = withSource('node', { state: 'off', summary: '', checkpoint: '', about: '', endpoints: [], ipfsNode: { state: 'off', summary: 'Not in use: a proxy is configured.' } })
    expect(candidate.visible?.(state)).toBe(true)
    expect(candidate.control.type === 'info' && candidate.control.text(state)).toBe('Not in use: a proxy is configured.')
  })
})
