import { describe, expect, it } from 'vitest'
import {
  classifyRequest, declaredOptional, heldSet, mergeGranted, patternCovers, promptLines, reconcileGranted, requiredOf,
  subtractGranted, type PermissionSet
} from '../optional-permissions.js'

const NONE: PermissionSet = { permissions: [], origins: [] }

const MV3 = {
  manifest_version: 3,
  permissions: ['storage', 'tabs'],
  host_permissions: ['https://required.example/*'],
  optional_permissions: ['history', 'bookmarks', 'webRequest', 'nativeMessaging'],
  optional_host_permissions: ['https://*.example.com/*', 'http://127.0.0.1/*']
}

const MV2 = {
  manifest_version: 2,
  permissions: ['storage', 'https://required.example/*'],
  optional_permissions: ['history', 'https://*.example.org/*']
}

describe('declaredOptional', () => {
  it('reads MV3 optional permissions and hosts, and leaves out a name Orivon never grants', () => {
    expect(declaredOptional(MV3)).toEqual({ permissions: ['history', 'bookmarks'], origins: ['https://*.example.com/*', 'http://127.0.0.1/*'] })
  })

  it('splits MV2\'s mixed optional_permissions', () => {
    expect(declaredOptional(MV2)).toEqual({ permissions: ['history'], origins: ['https://*.example.org/*'] })
  })

  it('is empty for a manifest that declares nothing', () => {
    expect(declaredOptional({ manifest_version: 3 })).toEqual(NONE)
  })
})

describe('held and required sets', () => {
  it('holds the required items and the grants together', () => {
    const held = heldSet(MV3, { permissions: ['history'], origins: ['http://127.0.0.1/*'] })
    expect(held.permissions).toEqual(['storage', 'tabs', 'history'])
    expect(held.origins).toEqual(['https://required.example/*', 'http://127.0.0.1/*'])
  })

  it('takes a grant out of a manifest it was merged into to find what is required', () => {
    const merged = { ...MV3, permissions: ['storage', 'tabs', 'history'] }
    expect(requiredOf(merged, { permissions: ['history'], origins: [] }).permissions).toEqual(['storage', 'tabs'])
  })
})

describe('patternCovers', () => {
  it.each([
    ['*://*.example.com/*', 'https://a.example.com/*', true],
    ['*://*.example.com/*', 'https://example.com/*', true],
    ['https://*.example.com/*', 'https://*.sub.example.com/*', true],
    ['https://example.com/*', 'https://*.example.com/*', false],
    ['https://example.com/*', 'http://example.com/*', false],
    ['*://example.com/*', 'http://example.com/*', true],
    ['https://example.com/a/*', 'https://example.com/a/b/*', true],
    ['https://example.com/a/b/*', 'https://example.com/a/*', false],
    ['<all_urls>', 'https://anything.test/*', true],
    ['<all_urls>', 'file:///*', false],
    ['*://*/*', '<all_urls>', false],
    ['https://example.com/*', '<all_urls>', false],
    ['file:///*', 'file:///*', true],
    ['https://example.com/*', 'not a pattern', false]
  ])('%s covers %s: %s', (outer, inner, expected) => {
    expect(patternCovers(outer, inner)).toBe(expected)
  })
})

describe('classifyRequest', () => {
  const request = (permissions: string[] = [], origins: string[] = []) => ({ permissions, origins })

  it('is held when everything asked for is required already', () => {
    expect(classifyRequest(MV3, NONE, request(['tabs'], ['https://required.example/*']))).toEqual({ kind: 'held' })
  })

  it('is held when everything asked for was granted', () => {
    expect(classifyRequest(MV3, { permissions: ['history'], origins: [] }, request(['history']))).toEqual({ kind: 'held' })
  })

  it('asks for a declared optional permission, and only for what is not held yet', () => {
    expect(classifyRequest(MV3, NONE, request(['tabs', 'history']))).toEqual({ kind: 'ask', permissions: ['history'], origins: [] })
  })

  it('refuses a permission the manifest never declared', () => {
    expect(classifyRequest(MV3, NONE, request(['downloads']))).toEqual({ kind: 'undeclared', item: 'downloads' })
  })

  it('refuses an origin the manifest never declared: the gap a plain grant left open', () => {
    expect(classifyRequest(MV3, NONE, request([], ['https://other.example/*']))).toEqual({ kind: 'undeclared', item: 'https://other.example/*' })
  })

  it('asks for an origin covered by a declared optional pattern', () => {
    expect(classifyRequest(MV3, NONE, request([], ['https://a.example.com/*']))).toEqual({ kind: 'ask', permissions: [], origins: ['https://a.example.com/*'] })
  })

  it('refuses a request wider than the declared pattern', () => {
    expect(classifyRequest(MV3, NONE, request([], ['https://*.com/*']))).toEqual({ kind: 'undeclared', item: 'https://*.com/*' })
    expect(classifyRequest(MV3, NONE, request([], ['<all_urls>']))).toEqual({ kind: 'undeclared', item: '<all_urls>' })
  })

  it('never offers a name Orivon does not provide, even when declared optional', () => {
    expect(classifyRequest(MV3, NONE, request(['webRequest']))).toEqual({ kind: 'never', item: 'webRequest' })
    expect(classifyRequest(MV3, NONE, request(['nativeMessaging']))).toEqual({ kind: 'never', item: 'nativeMessaging' })
  })

  it('never offers a file: origin, declared or not', () => {
    const withFile = { ...MV3, optional_host_permissions: ['file:///*'] }
    expect(classifyRequest(withFile, NONE, request([], ['file:///*']))).toEqual({ kind: 'undeclared', item: 'file:///*' })
  })

  it('refuses a host pattern named as a permission and a permission named as an origin', () => {
    expect(classifyRequest(MV3, NONE, request(['https://a.example.com/*']))).toEqual({ kind: 'undeclared', item: 'https://a.example.com/*' })
    expect(classifyRequest(MV3, NONE, request([], ['history']))).toEqual({ kind: 'undeclared', item: 'history' })
  })

  it('reads MV2 the same way', () => {
    expect(classifyRequest(MV2, NONE, request(['history'], ['https://x.example.org/*']))).toEqual({ kind: 'ask', permissions: ['history'], origins: ['https://x.example.org/*'] })
  })

  it('is held for an empty request', () => {
    expect(classifyRequest(MV3, NONE, request())).toEqual({ kind: 'held' })
  })
})

describe('promptLines', () => {
  it('words permissions first, then hosts, and names one that has no words', () => {
    expect(promptLines({ permissions: ['history', 'nonsense'], origins: ['https://a.example.com/*', '<all_urls>'] })).toEqual([
      { words: 'Read and change your browsing history' },
      { name: 'nonsense' },
      { words: 'Read and change your data on a.example.com' },
      { words: 'Read and change your data on every website' }
    ])
  })

  it('does not list one line twice', () => {
    expect(promptLines({ permissions: ['tabs', 'webNavigation'], origins: [] })).toHaveLength(1)
  })
})

describe('merge, subtract and reconcile', () => {
  it('merges without duplicates and subtracts what was taken back', () => {
    const merged = mergeGranted({ permissions: ['history'], origins: [] }, { permissions: ['history', 'bookmarks'], origins: ['https://a.example.com/*'] })
    expect(merged).toEqual({ permissions: ['history', 'bookmarks'], origins: ['https://a.example.com/*'] })
    expect(subtractGranted(merged, { permissions: ['history'], origins: [] })).toEqual({ permissions: ['bookmarks'], origins: ['https://a.example.com/*'] })
  })

  it('drops a grant the new manifest requires and revokes one it stopped declaring', () => {
    const next = { manifest_version: 3, permissions: ['history'], optional_permissions: ['bookmarks'], optional_host_permissions: ['https://*.example.com/*'] }
    const granted = { permissions: ['history', 'bookmarks', 'downloads'], origins: ['https://a.example.com/*', 'https://gone.example/*'] }
    expect(reconcileGranted(next, granted)).toEqual({ permissions: ['bookmarks'], origins: ['https://a.example.com/*'] })
  })

  it('drops a granted origin the new manifest now requires', () => {
    const next = { manifest_version: 3, host_permissions: ['https://*.example.com/*'], optional_host_permissions: ['https://*.example.com/*'] }
    expect(reconcileGranted(next, { permissions: [], origins: ['https://a.example.com/*'] })).toEqual(NONE)
  })
})
