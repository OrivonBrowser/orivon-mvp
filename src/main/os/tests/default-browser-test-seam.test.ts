import { describe, expect, it } from 'vitest'
import { parseSeamMode, recordingHost, testDefaultBrowserHost } from '../default-browser-test-seam.js'

describe('the default-browser test seam', () => {
  it('reads the three modes and nothing else', () => {
    expect(['can-set', 'default', 'declined'].map(parseSeamMode)).toEqual(['can-set', 'default', 'declined'])
    for (const bad of [undefined, '', 'yes', 'DEFAULT']) expect(parseSeamMode(bad)).toBeUndefined()
  })

  it('is absent outside a test build, whatever the environment says', () => {
    expect(testDefaultBrowserHost({ ORIVON_TEST_DEFAULT_BROWSER: 'can-set' })).toBeUndefined()
  })

  it('records what it is asked, and flips only when it accepts', async () => {
    const accepting = recordingHost('can-set')
    expect(await accepting.isDefault('http')).toBe(false)
    expect(accepting.setDefault('http')).toBe(true)
    expect(await accepting.isDefault('https')).toBe(true)
    expect(accepting.recording).toEqual({ isDefault: ['http', 'https'], setDefault: ['http'], opened: 0, registered: true })

    const declining = recordingHost('declined')
    expect(declining.setDefault('http')).toBe(false)
    expect(await declining.isDefault('http')).toBe(false)

    expect(await recordingHost('default').isDefault('http')).toBe(true)
  })
})
