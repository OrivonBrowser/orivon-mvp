import { describe, expect, it, vi } from 'vitest'

// dnr-api.ts imports the 'orivon:crx-extensions-router' virtual specifier at
// module scope for setPermissionCheck (electron-chrome-extensions-lib.d.ts's
// own header, and extension-host.test.ts's own doc on this same pattern).
vi.mock('orivon:crx-extensions-router', () => ({ setPermissionCheck: vi.fn() }))

const { isStrippedPermissionName, toDnrRequest, toUpdateRuleOptions, toUpdateRulesetOptions } = await import('../dnr-api.js')

describe('toUpdateRuleOptions', () => {
  it('passes through valid arrays', () => {
    expect(toUpdateRuleOptions({ removeRuleIds: [1, 2], addRules: [{ id: 3 }] })).toEqual({
      removeRuleIds: [1, 2],
      addRules: [{ id: 3 }],
    })
  })

  it('omits a field entirely rather than sending it as undefined (exactOptionalPropertyTypes)', () => {
    const result = toUpdateRuleOptions({})
    expect('removeRuleIds' in result).toBe(false)
    expect('addRules' in result).toBe(false)
  })

  it('never throws on malformed input: null, a non-array field, or a bare non-object', () => {
    expect(toUpdateRuleOptions(null)).toEqual({})
    expect(toUpdateRuleOptions('garbage')).toEqual({})
    expect(toUpdateRuleOptions({ removeRuleIds: 'not an array' })).toEqual({})
    expect(toUpdateRuleOptions(undefined)).toEqual({})
  })
})

describe('toUpdateRulesetOptions', () => {
  it('passes through valid arrays and omits absent fields', () => {
    expect(toUpdateRulesetOptions({ enableRulesetIds: ['a'] })).toEqual({ enableRulesetIds: ['a'] })
    expect(toUpdateRulesetOptions({})).toEqual({})
  })

  it('never throws on malformed input', () => {
    expect(toUpdateRulesetOptions(null)).toEqual({})
    expect(toUpdateRulesetOptions(42)).toEqual({})
  })
})

describe('toDnrRequest', () => {
  it('defaults method to get and tabId to -1, omits initiator when absent', () => {
    const request = toDnrRequest({ url: 'https://a.example/', type: 'xmlhttprequest' })
    expect(request).toEqual({ url: 'https://a.example/', method: 'get', resourceType: 'xmlhttprequest', tabId: -1, frameId: 0 })
  })

  it('carries through an explicit method/tabId/initiator', () => {
    const request = toDnrRequest({
      url: 'https://a.example/',
      type: 'script',
      method: 'POST',
      tabId: 7,
      initiator: 'https://b.example/',
    })
    expect(request).toEqual({
      url: 'https://a.example/',
      method: 'POST',
      resourceType: 'script',
      initiator: 'https://b.example/',
      tabId: 7,
      frameId: 0,
    })
  })
})

describe('isStrippedPermissionName', () => {
  it('is true for nativeMessaging and every declarativeNetRequest*/webRequest* permission', () => {
    expect(isStrippedPermissionName('nativeMessaging')).toBe(true)
    expect(isStrippedPermissionName('declarativeNetRequest')).toBe(true)
    expect(isStrippedPermissionName('declarativeNetRequestWithHostAccess')).toBe(true)
    expect(isStrippedPermissionName('declarativeNetRequestFeedback')).toBe(true)
    expect(isStrippedPermissionName('webRequest')).toBe(true)
    expect(isStrippedPermissionName('webRequestBlocking')).toBe(true)
  })

  it('is false for a permission loadableManifest never strips', () => {
    expect(isStrippedPermissionName('tabs')).toBe(false)
    expect(isStrippedPermissionName('storage')).toBe(false)
    expect(isStrippedPermissionName('activeTab')).toBe(false)
  })
})
