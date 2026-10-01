import { describe, expect, it } from 'vitest'
import { isFontName, isHostList, isLanguageTagList, MAX_LANGUAGE_TAGS, MAX_LISTED_HOSTS } from '../list-checks.js'
import { isSettingKey, SETTINGS, validateSetting } from '../schema.js'

// The settings of the layout, reading and accessibility features: each exists, and is inert until its feature reads it.
const KEYS = [
  'sidePanel.side',
  'performance.memorySaver', 'performance.sleepAfter', 'performance.keepAwake', 'performance.energySaver',
  'reader.font', 'reader.size', 'reader.width', 'reader.theme',
  'accessibility.caretBrowsing', 'accessibility.caretAsk'
]

describe('the layout, reading and accessibility settings', () => {
  it.each(KEYS)('%s is a setting whose default the schema accepts', (key) => {
    expect(isSettingKey(key)).toBe(true)
    const spec = SETTINGS[key as keyof typeof SETTINGS]
    expect(validateSetting(spec, spec.default)).toBe(spec.default)
  })

  it('leaves the extensions toolbar setting to the feature that owns it', () => {
    expect(isSettingKey('toolbar.extensions')).toBe(false)
  })

  it.each([
    ['sidePanel.side', 'right'], ['performance.memorySaver', true], ['performance.sleepAfter', '2h'], ['performance.keepAwake', ''],
    ['performance.energySaver', 'off'], ['reader.size', '18'], ['reader.width', 'medium'], ['reader.theme', 'auto'],
    ['accessibility.caretBrowsing', false], ['accessibility.caretAsk', true]
  ])('%s starts as %s', (key, expected) => {
    expect(SETTINGS[key as keyof typeof SETTINGS].default).toBe(expected)
  })

  it('refuses a value outside an enum', () => {
    for (const [key, bad] of [['sidePanel.side', 'top'], ['performance.sleepAfter', '5m'], ['reader.size', '17']]) {
      expect(validateSetting(SETTINGS[key as keyof typeof SETTINGS], bad), `${String(key)}=${String(bad)}`).toBeUndefined()
    }
  })

  it('keeps the site list setting to its check', () => {
    expect(validateSetting(SETTINGS['performance.keepAwake'], 'a.example\nb.example')).toBe('a.example\nb.example')
    expect(validateSetting(SETTINGS['performance.keepAwake'], 'A.example')).toBeUndefined()
  })
})

describe('isHostList', () => {
  it.each([
    ['', true], ['example.com', true], ['a.example\nb.example', true], ['localhost', true], ['xn--bcher-kva.example', true],
    ['Example.com', false], ['a.example\n', false], ['\na.example', false], ['a.example\n\nb.example', false], ['a b', false],
    ['https://a.example', false], ['a.example/path', false], ['a.example:8080', false], ['x'.repeat(254), false]
  ])('%j is %s', (value, expected) => {
    expect(isHostList(value)).toBe(expected)
  })

  it('takes at most the listed number of sites', () => {
    const lines = (count: number): string => Array.from({ length: count }, (_, i) => `h${String(i)}.example`).join('\n')

    expect(isHostList(lines(MAX_LISTED_HOSTS))).toBe(true)
    expect(isHostList(lines(MAX_LISTED_HOSTS + 1))).toBe(false)
  })
})

describe('isFontName', () => {
  it.each([
    ['', true], ['Arial', true], ['DejaVu Sans Mono', true], ['Noto Sans CJK JP', true], ['Inter_Var-2', true], ['Hiragino 角ゴ', true],
    ['Arial, sans-serif', false], ['a"b', false], ['a;b', false], ['a{b}', false], ['x'.repeat(65), false]
  ])('%j is %s', (value, expected) => {
    expect(isFontName(value)).toBe(expected)
  })
})

describe('isLanguageTagList', () => {
  it.each([
    ['', true], ['en', true], ['en-US', true], ['en-US,it,zh-Hant-TW', true], ['fil', true],
    ['e', false], ['en_US', false], ['en-US, it', false], ['en,', false], [',en', false], ['EN', false], ['en-', false], ['english', false]
  ])('%j is %s', (value, expected) => {
    expect(isLanguageTagList(value)).toBe(expected)
  })

  it('takes at most the listed number of tags', () => {
    const tags = (count: number): string => Array.from({ length: count }, () => 'en').join(',')

    expect(isLanguageTagList(tags(MAX_LANGUAGE_TAGS))).toBe(true)
    expect(isLanguageTagList(tags(MAX_LANGUAGE_TAGS + 1))).toBe(false)
  })
})
