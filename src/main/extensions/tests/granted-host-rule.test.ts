import { afterEach, describe, expect, it } from 'vitest'
import { normalizePrefs } from '../extension-prefs.js'
import { HOST_ACCESS_RULES, hostAccessFor } from '../extension-host-access.js'
import { grantedHostRule, setGrantedHostSource } from '../granted-host-rule.js'

const ID = 'a'.repeat(32)
const store = (origins: string[]) => ({ get: () => normalizePrefs({ granted: { origins } }) })
const MANIFEST = { manifest_version: 3, name: 'x', version: '1', host_permissions: ['https://required.example/*'] }

afterEach(() => { setGrantedHostSource(undefined) })

describe('grantedHostRule', () => {
  it('is one of the host access rules', () => {
    expect(HOST_ACCESS_RULES).toContain(grantedHostRule)
  })

  it('answers true for a URL a granted origin covers, and nothing else', () => {
    setGrantedHostSource(store(['https://*.example.com/*']))
    expect(grantedHostRule({ extensionId: ID, url: 'https://a.example.com/x' })).toBe(true)
    expect(grantedHostRule({ extensionId: ID, url: 'https://other.example/x' })).toBeUndefined()
    expect(grantedHostRule({ extensionId: ID, url: undefined })).toBeUndefined()
  })

  it('never answers for a file: URL', () => {
    setGrantedHostSource(store(['<all_urls>']))
    expect(grantedHostRule({ extensionId: ID, url: 'file:///etc/passwd' })).toBeUndefined()
  })

  it('answers nothing before a store is handed in', () => {
    expect(grantedHostRule({ extensionId: ID, url: 'https://a.example.com/x' })).toBeUndefined()
  })

  it('widens hostAccessFor at once, ahead of the manifest', () => {
    expect(hostAccessFor(ID, MANIFEST, 'https://a.example.com/x')).toBe(false)
    setGrantedHostSource(store(['https://*.example.com/*']))
    expect(hostAccessFor(ID, MANIFEST, 'https://a.example.com/x')).toBe(true)
    expect(hostAccessFor(ID, MANIFEST, 'https://required.example/x')).toBe(true)
    expect(hostAccessFor(ID, MANIFEST, 'https://nope.example/x')).toBe(false)
  })
})
