import { describe, expect, it } from 'vitest'
import { applyGlobalPrivacyControl, SIGNAL_OFF_BLINK_FEATURE, SIGNAL_ON_FEATURE, withFeature } from '../gpc-switch.js'

function commandLine (initial: Record<string, string> = {}) {
  const switches: Record<string, string> = { ...initial }
  return { switches, api: { getSwitchValue: (name: string) => switches[name] ?? '', appendSwitch: (name: string, value: string) => { switches[name] = value } } }
}

describe('withFeature', () => {
  it('names the feature once, after the ones already named', () => {
    expect(withFeature('', SIGNAL_ON_FEATURE)).toBe(SIGNAL_ON_FEATURE)
    expect(withFeature('A,B', SIGNAL_ON_FEATURE)).toBe(`A,B,${SIGNAL_ON_FEATURE}`)
    expect(withFeature(`A,${SIGNAL_ON_FEATURE}`, SIGNAL_ON_FEATURE)).toBe(`A,${SIGNAL_ON_FEATURE}`)
  })
})

describe('applyGlobalPrivacyControl', () => {
  it('turns the signal on, keeping what another part enabled', () => {
    const { switches, api } = commandLine({ 'enable-features': 'Other' })
    applyGlobalPrivacyControl(api, true)
    expect(switches).toEqual({ 'enable-features': `Other,${SIGNAL_ON_FEATURE}` })
  })

  it('exposes the property as false when the signal is off, keeping what another part enabled', () => {
    const { switches, api } = commandLine({ 'enable-blink-features': 'Other' })
    applyGlobalPrivacyControl(api, false)
    expect(switches).toEqual({ 'enable-blink-features': `Other,${SIGNAL_OFF_BLINK_FEATURE}` })
  })
})
