import { describe, expect, it, vi } from 'vitest'
import { createMemoryExtensionPrefs, defaultExtensionPrefs } from '../extension-prefs-stub.js'
import { openExtensionPrefs } from '../extension-prefs-open.js'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('the in-memory preferences store', () => {
  it('returns defaults for an id it has never seen', () => {
    expect(createMemoryExtensionPrefs().get('x')).toEqual(defaultExtensionPrefs())
  })

  it('merges a patch field by field and never shares its own objects with a caller', () => {
    const store = createMemoryExtensionPrefs()
    store.update('x', { pinned: true })
    store.update('x', { siteAccess: { mode: 'click', sites: ['https://a.example'] } })
    const first = store.get('x')
    expect(first.pinned).toBe(true)
    expect(first.siteAccess.mode).toBe('click')
    first.siteAccess.sites.push('https://evil.example')
    expect(store.get('x').siteAccess.sites).toEqual(['https://a.example'])
  })

  it('notifies listeners on update and forget, and stops after the unsubscribe', () => {
    const store = createMemoryExtensionPrefs()
    const listener = vi.fn()
    const off = store.onChange(listener)
    store.update('x', { pinned: false })
    store.forget('x')
    expect(listener.mock.calls).toEqual([['x'], ['x']])
    off()
    store.update('x', { pinned: true })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('openExtensionPrefs', () => {
  it('writes nothing under the profile in a private runtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orivon-prefs-'))
    const store = openExtensionPrefs(dir, true)
    store.update('x', { pinned: true })
    expect(store.get('x').pinned).toBe(true)
    expect(readdirSync(dir)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})
