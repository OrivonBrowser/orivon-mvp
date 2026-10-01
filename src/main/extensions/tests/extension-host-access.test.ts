import { describe, expect, it } from 'vitest'
import { HOST_ACCESS_RULES, apiOrHostAccessFor, hasApiOrHostAccess, hasApiPermission, hasHostAccess, hostAccessFor, type HostAccessRule } from '../extension-host-access.js'

const MANIFEST_WITH_COOKIES = { manifest_version: 3, name: 'x', version: '1.0.0', permissions: ['cookies'] }
const MANIFEST_WITH_HOST = { manifest_version: 3, name: 'x', version: '1.0.0', host_permissions: ['https://a.example/*'] }
const MANIFEST_BARE = { manifest_version: 3, name: 'x', version: '1.0.0' }
const MANIFEST_WITH_CONTENT_SCRIPT_ONLY = {
  manifest_version: 3,
  name: 'x',
  version: '1.0.0',
  content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'] }]
}

describe('hasApiPermission', () => {
  it('is true when the named permission is declared', () => {
    expect(hasApiPermission(MANIFEST_WITH_COOKIES, 'cookies')).toBe(true)
  })

  it('is false when it is not declared, or the manifest is not object-shaped', () => {
    expect(hasApiPermission(MANIFEST_BARE, 'cookies')).toBe(false)
    expect(hasApiPermission(null, 'cookies')).toBe(false)
    expect(hasApiPermission(undefined, 'cookies')).toBe(false)
    expect(hasApiPermission('not an object', 'cookies')).toBe(false)
  })
})

describe('hasHostAccess', () => {
  it('is true when a declared host pattern covers the URL', () => {
    expect(hasHostAccess(MANIFEST_WITH_HOST, 'https://a.example/path')).toBe(true)
  })

  it('is false for a URL outside every declared pattern', () => {
    expect(hasHostAccess(MANIFEST_WITH_HOST, 'https://b.example/path')).toBe(false)
  })

  it('is false for an undefined URL', () => {
    expect(hasHostAccess(MANIFEST_WITH_HOST, undefined)).toBe(false)
  })

  it('is false for a manifest readExtensionManifest itself refuses', () => {
    expect(hasHostAccess({ manifest_version: 3, name: 'x' }, 'https://a.example/path')).toBe(false)
  })

  it('is false for a URL covered only by a content_scripts match, with no host_permissions', () => {
    expect(hasHostAccess(MANIFEST_WITH_CONTENT_SCRIPT_ONLY, 'https://a.example/path')).toBe(false)
  })

  // README.md's "allowFileAccess is never true" entry: no extension ever
  // gets file access, so file: is never covered here, even by <all_urls>.
  it('is false for a file: URL, even with an <all_urls> host permission', () => {
    const manifestWithAllUrls = { manifest_version: 3, name: 'x', version: '1.0.0', host_permissions: ['<all_urls>'] }
    expect(hasHostAccess(manifestWithAllUrls, 'file:///etc/passwd')).toBe(false)
  })
})

describe('hasApiOrHostAccess', () => {
  it('is true from the API permission alone, with no host access at all', () => {
    expect(hasApiOrHostAccess(MANIFEST_WITH_COOKIES, 'cookies', 'https://anything.example/')).toBe(true)
  })

  it('is true from host access alone, with no API permission declared', () => {
    expect(hasApiOrHostAccess(MANIFEST_WITH_HOST, 'tabs', 'https://a.example/path')).toBe(true)
  })

  it('is false when neither is present', () => {
    expect(hasApiOrHostAccess(MANIFEST_BARE, 'tabs', 'https://a.example/path')).toBe(false)
  })
})

describe('hostAccessFor', () => {
  const ID = 'a'.repeat(32)
  const withRules = <T>(rules: HostAccessRule[], run: () => T): T => {
    const live = HOST_ACCESS_RULES as HostAccessRule[]
    const original = [...live]
    live.splice(0, live.length, ...rules, ...original)
    try { return run() } finally { live.splice(0, live.length, ...original) }
  }

  it('answers exactly as hasHostAccess does while no rule has anything to say', () => {
    for (const url of ['https://a.example/path', 'https://b.example/path', undefined, 'file:///etc/passwd']) {
      expect(hostAccessFor(ID, MANIFEST_WITH_HOST, url, 3)).toBe(hasHostAccess(MANIFEST_WITH_HOST, url))
    }
  })

  it('takes the first rule that answers, and a rule that abstains passes the question on', () => {
    const seen: unknown[] = []
    const abstain: HostAccessRule = (q) => { seen.push(q); return undefined }
    expect(withRules([abstain, () => true, () => false], () => hostAccessFor(ID, MANIFEST_BARE, 'https://x.example/', 9))).toBe(true)
    expect(withRules([() => false], () => hostAccessFor(ID, MANIFEST_WITH_HOST, 'https://a.example/'))).toBe(false)
    expect(seen).toEqual([{ extensionId: ID, url: 'https://x.example/', tabId: 9 }])
  })

  it('falls back to the manifest when every rule abstains', () => {
    expect(withRules([() => undefined], () => hostAccessFor(ID, MANIFEST_WITH_HOST, 'https://a.example/'))).toBe(true)
  })
})

describe('apiOrHostAccessFor', () => {
  const ID = 'a'.repeat(32)

  it('is the API permission or host access, either one', () => {
    expect(apiOrHostAccessFor(ID, MANIFEST_WITH_COOKIES, 'cookies', 'https://anything.example/')).toBe(true)
    expect(apiOrHostAccessFor(ID, MANIFEST_WITH_HOST, 'tabs', 'https://a.example/path')).toBe(true)
    expect(apiOrHostAccessFor(ID, MANIFEST_BARE, 'tabs', 'https://a.example/path')).toBe(false)
  })
})
