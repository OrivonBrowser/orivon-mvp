import { describe, expect, it } from 'vitest'
import { PERMISSION_WORDS, friendlyHost, hostWords, isAllSitesPattern } from '../extension-permission-words.js'
import { describeExtensionInstall, readExtensionManifest, updateRequiresConsent, type ExtensionManifestFacts } from '../extension-manifest.js'

function facts (permissions: string[], hosts: string[] = []): ExtensionManifestFacts {
  const result = readExtensionManifest({ manifest_version: 3, name: 'X', version: '1.0.0', permissions, host_permissions: hosts })
  if (!result.ok) throw new Error(result.reason)
  return result.facts
}

describe('PERMISSION_WORDS', () => {
  it('words every permission this packet serves, and nothing for sidePanel or activeTab', () => {
    expect(PERMISSION_WORDS.bookmarks).toBe('Read and change your bookmarks')
    expect(PERMISSION_WORDS.history).toBe('Read and change your browsing history')
    expect(PERMISSION_WORDS.topSites).toBe('Read a list of your most visited websites')
    expect(PERMISSION_WORDS.downloads).toBe('Manage your downloads')
    expect(PERMISSION_WORDS['downloads.open']).toBe('Open downloaded files')
    expect(PERMISSION_WORDS.sessions).toBe('Read your recently closed tabs')
    expect(PERMISSION_WORDS.browsingData).toBe('Clear your browsing data')
    expect(PERMISSION_WORDS.management).toBe('Manage your extensions')
    expect(PERMISSION_WORDS.readingList).toBe('Read and change your reading list')
    expect(PERMISSION_WORDS.search).toBe('Search with your default search engine')
    expect(PERMISSION_WORDS.tabGroups).toBe('View and manage your tab groups')
    expect(PERMISSION_WORDS.pageCapture).toBe('Save pages you visit')
    expect(PERMISSION_WORDS.identity).toBe('Ask you to sign in to other websites')
    expect(PERMISSION_WORDS.webRequest).toBe('See the requests websites make')
    expect(PERMISSION_WORDS.privacy).toBe('Read your privacy settings')
    expect('sidePanel' in PERMISSION_WORDS).toBe(false)
    expect('activeTab' in PERMISSION_WORDS).toBe(false)
  })

  it('has no empty line', () => {
    for (const line of Object.values(PERMISSION_WORDS)) expect(line.trim()).not.toBe('')
  })
})

describe('hostWords', () => {
  it('words a single host', () => {
    expect(hostWords('https://example.com/*')).toBe('Read and change your data on example.com')
    expect(hostWords('*://example.com:8080/path')).toBe('Read and change your data on example.com:8080')
  })

  it('says every website for a pattern that covers any host', () => {
    expect(hostWords('<all_urls>')).toBe('Read and change your data on every website')
    expect(hostWords('*://*/*')).toBe('Read and change your data on every website')
    expect(hostWords('https://*/*')).toBe('Read and change your data on every website')
  })

  it('names the subdomains a wildcard host covers', () => {
    expect(hostWords('*://*.example.com/*')).toBe('Read and change your data on example.com and its subdomains')
  })

  it('falls back to the raw text for something that is not a pattern', () => {
    expect(hostWords('nonsense')).toBe('Read and change your data on nonsense')
  })
})

describe('the helpers describeHostAccess shares', () => {
  it('knows the two all-sites patterns and nothing narrower', () => {
    expect(isAllSitesPattern('<all_urls>')).toBe(true)
    expect(isAllSitesPattern('*://*/*')).toBe(true)
    expect(isAllSitesPattern('http://*/*')).toBe(false)
    expect(friendlyHost('https://a.example/x')).toBe('a.example')
  })
})

describe('describeExtensionInstall reads PERMISSION_WORDS', () => {
  it('adds a line for each new API permission, once, and keeps the older lines unchanged', () => {
    const detail = describeExtensionInstall(facts(['history', 'topSites', 'downloads', 'downloads.open', 'sidePanel', 'activeTab', 'management', 'privacy']), 'store').detail.split('\n')
    expect(detail).toContain('Read and change your browsing history')
    expect(detail).toContain('Read a list of your most visited websites')
    expect(detail).toContain('Open downloaded files')
    expect(detail.filter((line) => line === 'Manage your downloads')).toHaveLength(1)
    expect(detail).toContain('Manage your apps, extensions, and themes')
    expect(detail).toContain('Change your privacy-related settings')
    expect(detail.some((line) => /side panel|active tab/i.test(line))).toBe(false)
  })

  it('shows nothing for an extension asking for no warned permission', () => {
    expect(describeExtensionInstall(facts(['storage', 'alarms', 'sidePanel']), 'file').detail).toBe('')
  })
})

describe('updateRequiresConsent with the new words', () => {
  it('asks again when an update adds history, but not when it adds a permission with no warning', () => {
    expect(updateRequiresConsent(facts(['storage']), facts(['storage', 'history']))).toBe(true)
    expect(updateRequiresConsent(facts(['storage']), facts(['storage', 'sidePanel']))).toBe(false)
    expect(updateRequiresConsent(facts(['history']), facts(['history']))).toBe(false)
  })
})
