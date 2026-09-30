import { describe, expect, it } from 'vitest'
import { MAX_LISTED_ADDRESSES, isAddressList, isEmptyOrAddress } from '../address-checks.js'
import { SETTINGS, validateSetting } from '../schema.js'

describe('isEmptyOrAddress', () => {
  it('takes nothing, or an address the bar would open', () => {
    for (const good of ['', 'https://a.example/', 'http://127.0.0.1:8080/x', 'example.com']) expect(isEmptyOrAddress(good)).toBe(true)
  })

  it('refuses a search, a script and a local file', () => {
    for (const bad of ['two words', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) expect(isEmptyOrAddress(bad)).toBe(false)
  })
})

describe('isAddressList', () => {
  it('takes an empty list and one address per line, skipping blank lines', () => {
    expect(isAddressList('')).toBe(true)
    expect(isAddressList('https://a.example/\n\n  https://b.example/  \n')).toBe(true)
  })

  it('refuses a list with one bad line, or more lines than the limit', () => {
    expect(isAddressList('https://a.example/\nnot an address')).toBe(false)
    const many = (count: number): string => Array.from({ length: count }, (_, index) => `https://a${String(index)}.example/`).join('\n')
    expect(isAddressList(many(MAX_LISTED_ADDRESSES))).toBe(true)
    expect(isAddressList(many(MAX_LISTED_ADDRESSES + 1))).toBe(false)
  })
})

describe('the start-up and page-content settings', () => {
  it('start closed to a launch that restores nothing, with Home off and the page tools on', () => {
    expect(SETTINGS['startup.mode']).toMatchObject({ kind: 'enum', default: 'newTab' })
    expect(SETTINGS['startup.pages']).toMatchObject({ kind: 'text', default: '', maxLength: 4096 })
    expect(SETTINGS['home.url']).toMatchObject({ kind: 'text', default: '', maxLength: 2048 })
    expect(SETTINGS['toolbar.home']).toMatchObject({ kind: 'bool', default: false })
    expect(SETTINGS['spellcheck.enabled']).toMatchObject({ kind: 'bool', default: true })
    expect(SETTINGS['pdf.viewer']).toMatchObject({ kind: 'bool', default: true })
  })

  it('accept only the values the pages may offer', () => {
    expect(validateSetting(SETTINGS['startup.mode'], 'continue')).toBe('continue')
    expect(validateSetting(SETTINGS['startup.mode'], 'restore')).toBeUndefined()
    expect(validateSetting(SETTINGS['home.url'], 'https://a.example/')).toBe('https://a.example/')
    expect(validateSetting(SETTINGS['home.url'], 'javascript:alert(1)')).toBeUndefined()
    expect(validateSetting(SETTINGS['startup.pages'], 'https://a.example/\nhttps://b.example/')).toBeDefined()
    expect(validateSetting(SETTINGS['startup.pages'], 'https://a.example/\nhello there')).toBeUndefined()
  })
})
