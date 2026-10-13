import { describe, expect, it } from 'vitest'
import { disableDnsPrefetching, withBlinkSetting } from '../dns-prefetch-switch.js'

function commandLine (initial: Record<string, string> = {}) {
  const switches: Record<string, string> = { ...initial }
  return { switches, api: { getSwitchValue: (name: string) => switches[name] ?? '', appendSwitch: (name: string, value: string) => { switches[name] = value } } }
}

describe('withBlinkSetting', () => {
  it('adds the setting after the ones already listed', () => {
    expect(withBlinkSetting('', 'dnsPrefetchingEnabled', 'false')).toBe('dnsPrefetchingEnabled=false')
    expect(withBlinkSetting('a=1,b=2', 'dnsPrefetchingEnabled', 'false')).toBe('a=1,b=2,dnsPrefetchingEnabled=false')
  })

  it('replaces an earlier value of the same setting instead of listing it twice', () => {
    expect(withBlinkSetting('dnsPrefetchingEnabled=true,a=1', 'dnsPrefetchingEnabled', 'false')).toBe('a=1,dnsPrefetchingEnabled=false')
  })
})

describe('disableDnsPrefetching', () => {
  it('sets the blink setting that stops a page resolving names the proxy should resolve', () => {
    const { switches, api } = commandLine()
    disableDnsPrefetching(api)
    expect(switches).toEqual({ 'blink-settings': 'dnsPrefetchingEnabled=false' })
  })

  it('keeps what another part already set', () => {
    const { switches, api } = commandLine({ 'blink-settings': 'forceDarkModeEnabled=true' })
    disableDnsPrefetching(api)
    expect(switches).toEqual({ 'blink-settings': 'forceDarkModeEnabled=true,dnsPrefetchingEnabled=false' })
  })
})
