import { describe, expect, it } from 'vitest'
import { normalizePrefs } from '../extension-prefs.js'
import { applyGrantedStage } from '../manifest-stage-granted.js'

const prefs = (permissions: string[], origins: string[]) => normalizePrefs({ granted: { permissions, origins } })

describe('applyGrantedStage', () => {
  it('returns the manifest it was given when nothing is granted', () => {
    const manifest = { manifest_version: 3, permissions: ['storage'] }
    expect(applyGrantedStage(manifest, prefs([], []))).toBe(manifest)
  })

  it('adds granted permissions to permissions and origins to host_permissions in MV3, without duplicates', () => {
    const manifest = { manifest_version: 3, permissions: ['storage', 'history'], host_permissions: ['https://a.example/*'] }
    const merged = applyGrantedStage(manifest, prefs(['history', 'bookmarks'], ['https://b.example/*']))
    expect(merged['permissions']).toEqual(['storage', 'history', 'bookmarks'])
    expect(merged['host_permissions']).toEqual(['https://a.example/*', 'https://b.example/*'])
  })

  it('creates host_permissions when an MV3 manifest had none', () => {
    const merged = applyGrantedStage({ manifest_version: 3 }, prefs([], ['https://b.example/*']))
    expect(merged['host_permissions']).toEqual(['https://b.example/*'])
    expect(merged).not.toHaveProperty('permissions')
  })

  it('puts MV2 origins in permissions, which has no host_permissions', () => {
    const merged = applyGrantedStage({ manifest_version: 2, permissions: ['storage'] }, prefs(['history'], ['https://b.example/*']))
    expect(merged['permissions']).toEqual(['storage', 'history', 'https://b.example/*'])
    expect(merged).not.toHaveProperty('host_permissions')
  })

  it('does not change its input', () => {
    const manifest = { manifest_version: 3, permissions: ['storage'] }
    applyGrantedStage(manifest, prefs(['history'], []))
    expect(manifest.permissions).toEqual(['storage'])
  })
})
