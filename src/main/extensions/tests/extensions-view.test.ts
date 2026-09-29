import { describe, expect, it } from 'vitest'
import {
  buildExtensionDetails, buildExtensionRow, describeSource, findExtension,
  iconMimeType, pickIconPath, resolveLocaleMessage, WHERE_EXTENSIONS_RUN
} from '../extensions-view.js'
import type { ExtensionFacts } from '../extensions-view.js'
import type { InstalledExtension } from '../registry.js'

const BASE: InstalledExtension = {
  id: 'abcdefghijklmnopabcdefghijklmnop',
  name: 'Fixture',
  version: '1.0.0',
  enabled: true,
  installedAt: 1000,
  updatedAt: 1000,
  source: { kind: 'unpacked', from: '/home/person/my-extension' },
  updater: { kind: 'none', reason: 'unpacked extensions have no update mechanism' },
  path: '/userData/extensions/u-aaaa/1.0.0',
  stripped: { permissions: [], optionalPermissions: [], declarativeNetRequest: undefined }
}

const NO_FACTS: ExtensionFacts = { resolvedName: 'Fixture', resolvedDescription: undefined, iconDataUrl: undefined, manifestFacts: undefined }

describe('pickIconPath', () => {
  it('is undefined with no icons', () => {
    expect(pickIconPath(undefined, 48)).toBeUndefined()
  })

  it('picks the largest icon at or under the max size', () => {
    expect(pickIconPath({ 16: 'icon16.png', 48: 'icon48.png', 128: 'icon128.png' }, 48)).toEqual({ size: 48, path: 'icon48.png' })
  })

  it('falls back to the smallest icon when none is small enough', () => {
    expect(pickIconPath({ 128: 'icon128.png', 256: 'icon256.png' }, 48)).toEqual({ size: 128, path: 'icon128.png' })
  })

  it('ignores a non-numeric key or a non-string path', () => {
    expect(pickIconPath({ any: 'icon.png', 32: 7 }, 48)).toBeUndefined()
  })
})

describe('iconMimeType', () => {
  it('names the type from the extension, case-insensitively', () => {
    expect(iconMimeType('icon.PNG')).toBe('image/png')
    expect(iconMimeType('icon.svg')).toBe('image/svg+xml')
  })

  it('falls back for an unknown or missing extension', () => {
    expect(iconMimeType('icon')).toBe('application/octet-stream')
    expect(iconMimeType('icon.bmp')).toBe('application/octet-stream')
  })
})

describe('resolveLocaleMessage', () => {
  it('resolves a __MSG_ reference, case-insensitively, from the catalogue', () => {
    const catalog = new Map([['extname', 'Resolved Name']])
    expect(resolveLocaleMessage('__MSG_extName__', catalog)).toBe('Resolved Name')
  })

  it('passes through a literal with no __MSG_ shape', () => {
    expect(resolveLocaleMessage('Literal Name', new Map())).toBe('Literal Name')
  })

  it('passes through an unresolved reference unchanged', () => {
    expect(resolveLocaleMessage('__MSG_missing__', new Map())).toBe('__MSG_missing__')
    expect(resolveLocaleMessage('__MSG_missing__', undefined)).toBe('__MSG_missing__')
  })
})

describe('describeSource', () => {
  it('names the folder for an unpacked install', () => {
    expect(describeSource({ kind: 'unpacked', from: '/home/person/my-extension' })).toBe('Unpacked folder /home/person/my-extension')
  })

  it('names just the file for a file install, even from a full path', () => {
    expect(describeSource({ kind: 'file', fileName: '/home/person/Downloads/thing.zip' })).toBe('File thing.zip')
  })

  it('names the store for a store install', () => {
    expect(describeSource({ kind: 'store', storeId: 'abc' })).toBe('Chrome Web Store')
  })
})

describe('findExtension', () => {
  it('finds an entry by id', () => {
    expect(findExtension([BASE], BASE.id)).toBe(BASE)
  })

  it('is undefined for an id no entry has, or a non-string id', () => {
    expect(findExtension([BASE], 'nope')).toBeUndefined()
    expect(findExtension([BASE], 42)).toBeUndefined()
    expect(findExtension([BASE], undefined)).toBeUndefined()
  })
})

describe('buildExtensionRow', () => {
  it('uses the resolved name and description, and the entry\'s own id/version/enabled', () => {
    const facts: ExtensionFacts = { resolvedName: 'Resolved', resolvedDescription: 'A description', iconDataUrl: 'data:image/png;base64,AA==', manifestFacts: undefined }
    expect(buildExtensionRow(BASE, facts)).toEqual({
      id: BASE.id, name: 'Resolved', version: '1.0.0', description: 'A description', enabled: true, iconDataUrl: 'data:image/png;base64,AA=='
    })
  })

  it('shows an empty description when none resolved', () => {
    expect(buildExtensionRow(BASE, NO_FACTS).description).toBe('')
  })
})

describe('buildExtensionDetails', () => {
  it('is reloadable only for an unpacked source', () => {
    expect(buildExtensionDetails(BASE, NO_FACTS).reloadable).toBe(true)
    const fileEntry: InstalledExtension = { ...BASE, source: { kind: 'file', fileName: 'thing.zip' } }
    expect(buildExtensionDetails(fileEntry, NO_FACTS).reloadable).toBe(false)
  })

  it('has no site access line when the manifest facts are missing', () => {
    expect(buildExtensionDetails(BASE, NO_FACTS).siteAccess).toBeUndefined()
  })

  it('always carries the updates sentence and the where-it-runs sentence', () => {
    const details = buildExtensionDetails(BASE, NO_FACTS)
    expect(details.updates).toContain('Reload it from /home/person/my-extension')
    expect(details.whereItRuns).toBe(WHERE_EXTENSIONS_RUN)
  })

  it('lists the stripped permissions in plain words', () => {
    const entry: InstalledExtension = { ...BASE, stripped: { permissions: ['webRequest', 'nativeMessaging'], optionalPermissions: [], declarativeNetRequest: undefined } }
    expect(buildExtensionDetails(entry, NO_FACTS).stripped).toEqual([
      'Network blocking rules: Orivon does not run these yet',
      'Talking to programs on your computer: not available in Orivon'
    ])
  })
})
