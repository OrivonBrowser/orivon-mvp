import { describe, expect, it } from 'vitest'
import { SETTINGS, describeSettings, isSettingKey, validateSetting } from '../schema.js'
import type { SettingSpec } from '../schema.js'

describe('validateSetting', () => {
  const enumSpec: SettingSpec = { kind: 'enum', options: ['a', 'b'], default: 'a' }
  const boolSpec: SettingSpec = { kind: 'bool', default: false }
  const intSpec: SettingSpec = { kind: 'int', default: 5, min: 1, max: 10 }
  const textSpec: SettingSpec = { kind: 'text', default: '', maxLength: 5, check: (value) => !value.includes('!') }

  it('accepts an enum option and nothing else', () => {
    expect(validateSetting(enumSpec, 'b')).toBe('b')
    for (const bad of ['c', '', 'A', 1, null, undefined, {}, ['a']]) expect(validateSetting(enumSpec, bad)).toBeUndefined()
  })

  it('accepts a boolean and not its lookalikes', () => {
    expect(validateSetting(boolSpec, true)).toBe(true)
    for (const bad of ['true', 1, 0, null, undefined]) expect(validateSetting(boolSpec, bad)).toBeUndefined()
  })

  it('accepts an integer inside its bounds', () => {
    expect(validateSetting(intSpec, 1)).toBe(1)
    expect(validateSetting(intSpec, 10)).toBe(10)
    for (const bad of [0, 11, 2.5, NaN, Infinity, '5', null]) expect(validateSetting(intSpec, bad)).toBeUndefined()
  })

  it('accepts text within its length and its check', () => {
    expect(validateSetting(textSpec, 'hello')).toBe('hello')
    expect(validateSetting(textSpec, '')).toBe('')
    for (const bad of ['toolong', 'no!', 5, null]) expect(validateSetting(textSpec, bad)).toBeUndefined()
  })
})

describe('the settings schema', () => {
  it('gives every setting a default that its own validator accepts', () => {
    for (const key of Object.keys(SETTINGS) as Array<keyof typeof SETTINGS>) {
      expect(validateSetting(SETTINGS[key], SETTINGS[key].default), key).toBe(SETTINGS[key].default)
    }
  })

  it('knows its keys, and only its own', () => {
    expect(isSettingKey('appearance.theme')).toBe(true)
    for (const key of ['toString', '__proto__', 'constructor', 'nope', '', 5, null]) expect(isSettingKey(key)).toBe(false)
  })

  it('describes every setting without a function, so it can cross IPC', () => {
    const description = describeSettings()

    expect(description.map((d) => d.key).sort()).toEqual(Object.keys(SETTINGS).sort())
    expect(JSON.parse(JSON.stringify(description))).toEqual(description)
  })

  it('only offers the custom search engine a usable template', () => {
    expect(validateSetting(SETTINGS['search.customUrl'], 'https://search.example/?q=%s')).toBe('https://search.example/?q=%s')
    expect(validateSetting(SETTINGS['search.customUrl'], 'https://%s.example/')).toBeUndefined()
    expect(validateSetting(SETTINGS['search.customUrl'], 'http://search.example/?q=%s')).toBeUndefined()
  })

  it('pins an extension installed from now on only when asked, and keeps the older setting for one with no recorded pin', () => {
    expect(SETTINGS['extensions.pinInstalled']).toEqual({ kind: 'bool', default: false })
    expect(SETTINGS['extensions.pinNew'].default).toBe(true)
  })
})
