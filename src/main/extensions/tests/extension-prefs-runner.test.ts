import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExtensionPrefsStore, prefsFilePath } from '../extension-prefs-runner.js'
import { DEFAULT_EXTENSION_PREFS } from '../extension-prefs.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orivon-prefs-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('createExtensionPrefsStore', () => {
  it('answers the defaults for an extension it has never heard of', () => {
    expect(createExtensionPrefsStore(prefsFilePath(dir)).get('x')).toBe(DEFAULT_EXTENSION_PREFS)
  })

  it('writes a change to <userData>/extensions/prefs.json and a new store reads it back', async () => {
    const store = createExtensionPrefsStore(prefsFilePath(dir))
    store.update('x', { pinned: true, granted: { permissions: ['history'], origins: [] } })
    await store.flush()
    expect(JSON.parse(readFileSync(join(dir, 'extensions', 'prefs.json'), 'utf8')).extensions.x.pinned).toBe(true)
    const again = createExtensionPrefsStore(prefsFilePath(dir))
    expect(again.get('x').pinned).toBe(true)
    expect(again.get('x').granted.permissions).toEqual(['history'])
  })

  it('tells listeners the id that changed, once per real change, and stops after the removal', () => {
    const store = createExtensionPrefsStore(null)
    const heard: string[] = []
    const off = store.onChange((id) => heard.push(id))
    store.update('x', { pinned: true })
    store.update('x', { pinned: true })
    store.update('y', { pinned: false })
    off()
    store.update('x', { pinned: false })
    expect(heard).toEqual(['x', 'y'])
  })

  it('writes nothing for a no-op update', async () => {
    const store = createExtensionPrefsStore(prefsFilePath(dir))
    store.update('x', {})
    store.update('x', { pinned: null })
    await store.flush()
    expect(existsSync(join(dir, 'extensions', 'prefs.json'))).toBe(false)
  })

  it('forgets an extension, notifies, and no longer stores it', async () => {
    const store = createExtensionPrefsStore(prefsFilePath(dir))
    store.update('x', { pinned: true })
    const listener = vi.fn()
    store.onChange(listener)
    store.forget('x')
    store.forget('x')
    await store.flush()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.get('x')).toBe(DEFAULT_EXTENSION_PREFS)
    expect(JSON.parse(readFileSync(join(dir, 'extensions', 'prefs.json'), 'utf8')).extensions).toEqual({})
  })

  it('starts from the defaults when the file is corrupt, without throwing', () => {
    mkdirSync(join(dir, 'extensions'), { recursive: true })
    writeFileSync(join(dir, 'extensions', 'prefs.json'), '{ not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(createExtensionPrefsStore(prefsFilePath(dir)).get('x')).toBe(DEFAULT_EXTENSION_PREFS)
    warn.mockRestore()
  })

  it('keeps everything in memory, and writes no file, with no path (a private runtime)', async () => {
    const store = createExtensionPrefsStore(null)
    store.update('x', { pinned: true })
    await store.flush()
    expect(store.get('x').pinned).toBe(true)
    expect(readdirOrEmpty(dir)).toEqual([])
  })
})

function readdirOrEmpty (path: string): string[] {
  return existsSync(path) ? readdirSync(path) : []
}
