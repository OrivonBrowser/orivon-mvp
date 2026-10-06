import { describe, expect, it } from 'vitest'
import { applyGlobalPrivacyControl, GPC_FEATURE, withFeature } from '../gpc-switch.js'

function commandLine (initial: Record<string, string> = {}) {
  const switches: Record<string, string> = { ...initial }
  return { switches, api: { getSwitchValue: (name: string) => switches[name] ?? '', appendSwitch: (name: string, value: string) => { switches[name] = value } } }
}

describe('withFeature', () => {
  it('names the feature once, after the ones already named', () => {
    expect(withFeature('', GPC_FEATURE)).toBe(GPC_FEATURE)
    expect(withFeature('A,B', GPC_FEATURE)).toBe(`A,B,${GPC_FEATURE}`)
    expect(withFeature(`A,${GPC_FEATURE}`, GPC_FEATURE)).toBe(`A,${GPC_FEATURE}`)
  })
})

describe('applyGlobalPrivacyControl', () => {
  it('turns the feature on, keeping what another part enabled', () => {
    const { switches, api } = commandLine({ 'enable-features': 'Other' })
    applyGlobalPrivacyControl(api, true)
    expect(switches['enable-features']).toBe(`Other,${GPC_FEATURE}`)
  })

  it('touches nothing when the signal is off', () => {
    const { switches, api } = commandLine()
    applyGlobalPrivacyControl(api, false)
    expect(switches).toEqual({})
  })
})
