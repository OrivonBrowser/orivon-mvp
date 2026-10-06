import { describe, expect, it } from 'vitest'
import { SETTINGS, validateSetting } from '../schema.js'

// The keys declared ahead of the controls that edit them: a value outside the choices is refused and the default is what a fresh profile has.
const ENUMS: ReadonlyArray<[key: keyof typeof SETTINGS, options: string[], fallback: string]> = [
  ['privacy.cookies', ['all', 'blockThirdParty'], 'all'],
  ['privacy.secureDns', ['off', 'automatic', 'cloudflare', 'quad9'], 'off'],
  ['sites.camera', ['ask', 'block'], 'ask'],
  ['sites.popups', ['block', 'allow'], 'block'],
  ['sites.javascript', ['allow', 'block'], 'allow']
]
const BOOLS: ReadonlyArray<[key: keyof typeof SETTINGS, fallback: boolean]> = [
  ['privacy.globalPrivacyControl', true],
  ['privacy.doNotTrack', false],
  ['privacy.httpsOnly', false],
  ['passwords.offerToSave', true],
  ['passwords.autofill', true],
  ['autofill.addresses', true]
]

describe('the site and privacy settings', () => {
  it.each(ENUMS)('%s offers its choices, defaults to %s and refuses anything else', (key, options, fallback) => {
    expect(SETTINGS[key]).toMatchObject({ kind: 'enum', options, default: fallback })
    expect(validateSetting(SETTINGS[key], 'maybe')).toBeUndefined()
  })

  it.each(BOOLS)('%s is a switch that starts at %s', (key, fallback) => {
    expect(SETTINGS[key]).toMatchObject({ kind: 'bool', default: fallback })
    expect(validateSetting(SETTINGS[key], 'yes')).toBeUndefined()
  })
})
