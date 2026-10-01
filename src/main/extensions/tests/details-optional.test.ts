import { describe, expect, it, vi } from 'vitest'
import type { ExtensionManifestFacts } from '../../../broker/policy/extension-manifest.js'
import { optionalPart, revokeOrigin, revokePermission } from '../details-optional.js'
import type { ExtensionsDomainDeps } from '../extensions-domain.js'
import { createExtensionPrefsStore } from '../extension-prefs-runner.js'
import type { ExtensionFacts } from '../extensions-view.js'
import type { InstalledExtension } from '../registry.js'

const ID = 'a'.repeat(32)
const entry = { id: ID } as InstalledExtension

function facts (optionalApiPermissions: string[], optionalHostPermissions: string[]): ExtensionFacts {
  return { resolvedName: 'x', resolvedDescription: undefined, iconDataUrl: undefined, manifestFacts: { optionalApiPermissions, optionalHostPermissions } as unknown as ExtensionManifestFacts }
}

function deps () {
  const prefs = createExtensionPrefsStore(null)
  const sendEvent = vi.fn()
  const applyManifest = vi.fn(async () => 'applied')
  const value = {
    prefs,
    extensions: { list: () => [entry], applyManifest },
    host: () => ({ getRouter: () => ({ sendEvent }) })
  } as unknown as ExtensionsDomainDeps
  return { prefs, sendEvent, applyManifest, deps: value }
}

describe('optionalPart', () => {
  it('is null when nothing optional is declared', () => {
    expect(optionalPart(entry, facts([], []), deps().deps)).toEqual({})
    expect(optionalPart(entry, { ...facts([], []), manifestFacts: undefined }, deps().deps)).toEqual({})
  })

  it('lists what is granted and, apart, what it may still ask for, in words', () => {
    const { deps: value, prefs } = deps()
    prefs.update(ID, { granted: { permissions: ['history'], origins: ['https://a.example.com/*'] } })
    expect(optionalPart(entry, facts(['history', 'bookmarks'], ['https://a.example.com/*', 'http://127.0.0.1/*']), value)).toEqual({
      optional: {
        granted: [
          { kind: 'permission', value: 'history', words: 'Read and change your browsing history' },
          { kind: 'origin', value: 'https://a.example.com/*', words: 'Read and change your data on a.example.com' }
        ],
        mayAsk: ['Read and change your bookmarks', 'Read and change your data on 127.0.0.1']
      }
    })
  })

  it('does not list a grant the manifest no longer declares', () => {
    const { deps: value, prefs } = deps()
    prefs.update(ID, { granted: { permissions: ['downloads'], origins: [] } })
    expect(optionalPart(entry, facts(['history'], []), value)).toEqual({ optional: { granted: [], mayAsk: ['Read and change your browsing history'] } })
  })
})

describe('the revoke commands', () => {
  it('take back one granted permission, tell the extension and apply the manifest', async () => {
    const { deps: value, prefs, sendEvent, applyManifest } = deps()
    prefs.update(ID, { granted: { permissions: ['history', 'bookmarks'], origins: [] } })
    expect(await revokePermission({ id: ID, permission: 'history' }, value)).toEqual({ ok: true })
    expect(prefs.get(ID).granted.permissions).toEqual(['bookmarks'])
    expect(sendEvent).toHaveBeenCalledWith(ID, 'permissions.onRemoved', { permissions: ['history'], origins: [] })
    expect(applyManifest).toHaveBeenCalledWith(ID, 'quiet')
  })

  it('take back one granted origin', async () => {
    const { deps: value, prefs } = deps()
    prefs.update(ID, { granted: { permissions: [], origins: ['https://a.example.com/*'] } })
    expect(await revokeOrigin({ id: ID, origin: 'https://a.example.com/*' }, value)).toEqual({ ok: true })
    expect(prefs.get(ID).granted.origins).toEqual([])
  })

  it('refuse a value that is not currently granted, an unknown extension and malformed fields', async () => {
    const { deps: value, prefs, applyManifest } = deps()
    prefs.update(ID, { granted: { permissions: ['history'], origins: [] } })
    expect(await revokePermission({ id: ID, permission: 'storage' }, value)).toBeUndefined()
    expect(await revokePermission({ id: 'b'.repeat(32), permission: 'history' }, value)).toBeUndefined()
    expect(await revokePermission({ id: ID, permission: 5 }, value)).toBeUndefined()
    expect(await revokeOrigin({ id: ID, origin: 'https://a.example.com/*' }, value)).toBeUndefined()
    expect(prefs.get(ID).granted.permissions).toEqual(['history'])
    expect(applyManifest).not.toHaveBeenCalled()
  })
})
