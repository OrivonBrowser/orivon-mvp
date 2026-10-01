import { describe, expect, it } from 'vitest'
import { describeExtensionInstall, describeOptionalAccess, permissionLine, readExtensionManifest } from '../extension-manifest.js'

function facts (extra: Record<string, unknown>) {
  const result = readExtensionManifest({ manifest_version: 3, name: 'Tidy Tabs', version: '1.0.0', ...extra })
  if (!result.ok) throw new Error(result.reason)
  return result.facts
}

describe('optionalHostPermissions', () => {
  it('reads optional_host_permissions and MV3-style host patterns in optional_permissions', () => {
    expect(facts({ optional_host_permissions: ['https://b.example/*', 'https://a.example/*'] }).optionalHostPermissions).toEqual(['https://a.example/*', 'https://b.example/*'])
    expect(facts({ manifest_version: 2, optional_permissions: ['history', 'https://a.example/*'] }).optionalHostPermissions).toEqual(['https://a.example/*'])
  })
})

describe('permissionLine', () => {
  it('words a permission from either list, and has none for one that needs none', () => {
    expect(permissionLine('history')).toBe('Read and change your browsing history')
    expect(permissionLine('cookies')).toBe('Read and change your cookies')
    expect(permissionLine('storage')).toBeUndefined()
  })
})

describe('describeOptionalAccess', () => {
  it('words optional permissions and hosts, leaving out one that is never granted', () => {
    expect(describeOptionalAccess(facts({ optional_permissions: ['history', 'webRequest', 'storage'], optional_host_permissions: ['*://*.example.com/*'] }))).toEqual([
      'Read and change your browsing history',
      'Read and change your data on example.com and its subdomains'
    ])
  })
})

describe('the install prompt', () => {
  it('lists what the extension may later ask for, after what it holds', () => {
    const { detail } = describeExtensionInstall(facts({ permissions: ['cookies'], optional_permissions: ['bookmarks'] }), 'file')
    expect(detail).toBe('Read and change your cookies\n\nIt may later ask for:\n- Read and change your bookmarks')
  })

  it('has no such section for an extension with nothing optional', () => {
    expect(describeExtensionInstall(facts({ permissions: ['cookies'] }), 'file').detail).toBe('Read and change your cookies')
  })

  it('starts with the section itself when nothing is required', () => {
    expect(describeExtensionInstall(facts({ optional_permissions: ['history'] }), 'file').detail).toBe('It may later ask for:\n- Read and change your browsing history')
  })

  it('caps the list and counts the rest', () => {
    const many = ['bookmarks', 'history', 'topSites', 'downloads', 'sessions', 'browsingData', 'management', 'readingList']
    const { detail } = describeExtensionInstall(facts({ optional_permissions: many }), 'file')
    expect(detail.split('\n').at(-1)).toBe('- and 2 more')
  })
})
