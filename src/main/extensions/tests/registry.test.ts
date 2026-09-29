import { describe, expect, it } from 'vitest'
import { describeUpdater, parseRegistry, serializeRegistry, type InstalledExtension } from '../registry.js'

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

describe('describeUpdater', () => {
  it('names the folder to reload for an unpacked extension', () => {
    expect(describeUpdater(BASE)).toBe('No automatic updates. Reload it from /home/person/my-extension to pick up changes.')
  })

  it('says to install a newer file for a .crx-sourced extension', () => {
    const entry: InstalledExtension = { ...BASE, source: { kind: 'file', fileName: 'my-extension.crx' } }
    expect(describeUpdater(entry)).toBe('No automatic updates. Install a newer file to update it.')
  })

  it('does not promise an in-place update for a .zip-sourced extension', () => {
    const entry: InstalledExtension = { ...BASE, source: { kind: 'file', fileName: 'my-extension.zip' } }
    expect(describeUpdater(entry)).toBe(
      'No automatic updates. A newer .zip with the same key updates it in place; ' +
      'a .zip with no key, or a different key, installs as a separate extension.'
    )
  })

  it('names the Chrome Web Store and its check cadence for a store-updated extension', () => {
    const entry: InstalledExtension = {
      ...BASE,
      source: { kind: 'store', storeId: 'abcdefghijklmnopabcdefghijklmnop' },
      updater: { kind: 'store', lastCheckedAt: 1000 }
    }
    const description = describeUpdater(entry)
    expect(description).toContain('Chrome Web Store')
    expect(description).toContain('every 5 hours')
    expect(description).toContain('signatures')
  })
})

describe('parseRegistry / serializeRegistry round-trip', () => {
  it('round-trips an empty registry', () => {
    expect(parseRegistry(serializeRegistry([]))).toEqual({ entries: [], corrupt: false })
  })

  it('round-trips a registry with entries of every source and updater kind', () => {
    const entries: InstalledExtension[] = [
      BASE,
      { ...BASE, id: 'b', source: { kind: 'file', fileName: 'x.zip' } },
      {
        ...BASE,
        id: 'c',
        source: { kind: 'store', storeId: 'c' },
        updater: { kind: 'store', lastCheckedAt: 5, lastResult: 'up to date' },
        stripped: { permissions: ['webRequest'], optionalPermissions: ['nativeMessaging'], declarativeNetRequest: { rule_resources: [] } }
      }
    ]
    const result = parseRegistry(serializeRegistry(entries))
    expect(result.corrupt).toBe(false)
    expect(result.entries).toEqual(entries)
  })
})

describe('parseRegistry: corrupt input fails closed to empty, never throws', () => {
  const cases: ReadonlyArray<{ label: string, raw: string }> = [
    { label: 'not JSON at all', raw: 'this is not json{{{' },
    { label: 'a JSON array instead of an object', raw: '[]' },
    { label: 'an object with no extensions key', raw: '{}' },
    { label: 'extensions not an array', raw: '{"extensions": "nope"}' },
    { label: 'an entry missing a required field', raw: JSON.stringify({ extensions: [{ id: 'x' }] }) },
    {
      label: 'an entry with an unrecognised source kind',
      raw: JSON.stringify({ extensions: [{ ...BASE, source: { kind: 'ftp', from: 'x' } }] })
    },
    {
      label: 'one good entry alongside one malformed entry -- the whole file fails closed',
      raw: JSON.stringify({ extensions: [BASE, { id: 'only-an-id' }] })
    }
  ]

  it.each(cases)('$label', ({ raw }) => {
    expect(() => parseRegistry(raw)).not.toThrow()
    expect(parseRegistry(raw)).toEqual({ entries: [], corrupt: true })
  })
})
