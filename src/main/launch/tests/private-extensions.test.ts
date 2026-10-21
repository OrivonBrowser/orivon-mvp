import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizePrefs, parsePrefsFile, serializePrefs } from '../../extensions/extension-prefs.js'
import type { ExtensionPrefs } from '../../extensions/extension-prefs.js'
import { parseRegistry, serializeRegistry } from '../../extensions/registry.js'
import type { InstalledExtension } from '../../extensions/registry.js'
import { copyPrivateExtensions, hasPrivateExtensions, privateCopyOfPrefs } from '../private-extensions.js'

const ALLOWED = 'a'.repeat(32)
const REFUSED = 'b'.repeat(32)
const OFF = 'c'.repeat(32)

let root: string
let from: string
let into: string
let warnings: string[]
const log = (message: string): void => { warnings.push(message) }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orivon-private-extensions-test-'))
  from = join(root, 'from')
  into = join(root, 'into')
  mkdirSync(from, { recursive: true })
  mkdirSync(into, { recursive: true })
  warnings = []
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function entry (id: string, slot: string, enabled = true): InstalledExtension {
  return {
    id,
    name: `Extension ${slot}`,
    version: '1.0.0',
    enabled,
    installedAt: 1,
    updatedAt: 2,
    source: { kind: 'unpacked', from: '/somewhere' },
    updater: { kind: 'none', reason: 'test' },
    path: join(from, 'extensions', slot, '1.0.0'),
    stripped: { permissions: [], optionalPermissions: [], declarativeNetRequest: undefined }
  }
}

function put (path: string, text = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** A profile holding the three extensions: ALLOWED is on and allowed in private windows, REFUSED is on but not allowed, OFF is allowed but disabled. */
function profile (extra: Partial<Record<string, ExtensionPrefs>> = {}): void {
  put(join(from, 'extensions', 'allowed', '1.0.0', 'manifest.json'), '{"name":"allowed"}')
  put(join(from, 'extensions', 'allowed', '1.0.0', 'sub', 'content.js'), 'content')
  put(join(from, 'extensions', 'allowed', 'key.pub'), 'KEY')
  put(join(from, 'extensions', 'refused', '1.0.0', 'manifest.json'), '{}')
  put(join(from, 'extensions', 'off', '1.0.0', 'manifest.json'), '{}')
  writeFileSync(join(from, 'extensions', 'registry.json'), serializeRegistry([entry(ALLOWED, 'allowed'), entry(REFUSED, 'refused'), entry(OFF, 'off', false)]))
  const prefs = new Map<string, ExtensionPrefs>([
    [ALLOWED, normalizePrefs({ privateWindows: true, pinned: true, noticeSeen: ['n'] })],
    [OFF, normalizePrefs({ privateWindows: true })],
    ...Object.entries(extra).map(([id, value]): [string, ExtensionPrefs] => [id, value as ExtensionPrefs])
  ])
  writeFileSync(join(from, 'extensions', 'prefs.json'), serializePrefs(prefs))
}

function files (dir: string): string[] {
  const found: string[] = []
  const walk = (current: string): void => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, item.name)
      if (item.isDirectory()) walk(path)
      else found.push(relative(dir, path).split('\\').join('/'))
    }
  }
  if (existsSync(dir)) walk(dir)
  return found.sort()
}

describe('the extensions a private session starts with', () => {
  it('copies an enabled extension that is allowed in private windows, and writes a registry of it with the path in the copy', async () => {
    profile()
    const copied = await copyPrivateExtensions(from, into, { log })

    expect(copied).toEqual([ALLOWED])
    expect(readFileSync(join(into, 'extensions', 'allowed', '1.0.0', 'sub', 'content.js'), 'utf8')).toBe('content')
    expect(readFileSync(join(into, 'extensions', 'allowed', 'key.pub'), 'utf8')).toBe('KEY')
    const registry = parseRegistry(readFileSync(join(into, 'extensions', 'registry.json'), 'utf8')).entries
    expect(registry.map((item) => item.id)).toEqual([ALLOWED])
    expect(registry[0]?.path).toBe(join(into, 'extensions', 'allowed', '1.0.0'))
    expect(registry[0]?.name).toBe('Extension allowed')
    expect(warnings).toEqual([])
  })

  it('leaves out an extension that is not allowed, one that is off, and a choice with no extension behind it', async () => {
    profile({ [OFF.replace(/c/g, 'd')]: normalizePrefs({ privateWindows: true }) })
    await copyPrivateExtensions(from, into, { log })

    expect(existsSync(join(into, 'extensions', 'refused'))).toBe(false)
    expect(existsSync(join(into, 'extensions', 'off'))).toBe(false)
    const prefs = parsePrefsFile(readFileSync(join(into, 'extensions', 'prefs.json'), 'utf8'))
    expect([...prefs.keys()]).toEqual([ALLOWED])
  })

  it('writes nothing at all when no extension is allowed, or the profile has none', async () => {
    await copyPrivateExtensions(from, into, { log })
    expect(files(into)).toEqual([])
    mkdirSync(join(from, 'extensions'), { recursive: true })
    writeFileSync(join(from, 'extensions', 'registry.json'), serializeRegistry([entry(REFUSED, 'refused')]))
    expect(await copyPrivateExtensions(from, into, { log })).toEqual([])
    expect(files(into)).toEqual([])
  })

  it('says whether there is anything to copy, without copying', () => {
    expect(hasPrivateExtensions(from)).toBe(false)
    profile()
    expect(hasPrivateExtensions(from)).toBe(true)
    expect(files(into)).toEqual([])
  })

  it('yields to the event loop while it copies, a few files at a time, so the process that asked stays responsive', async () => {
    profile()
    for (let n = 0; n < 300; n += 1) put(join(from, 'Local Extension Settings', ALLOWED, `${String(n).padStart(6, '0')}.ldb`), 'x'.repeat(1024))
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 1)
    let running = 0
    let most = 0
    const copyFile = async (source: string, target: string): Promise<void> => {
      running += 1
      most = Math.max(most, running)
      await new Promise((resolve) => setImmediate(resolve))
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, readFileSync(source))
      running -= 1
    }
    const done = copyPrivateExtensions(from, into, { log, copyFile })
    expect(files(into)).toEqual([])
    await done
    clearInterval(timer)
    expect(ticks).toBeGreaterThan(0)
    expect(most).toBeGreaterThan(1)
    expect(most).toBeLessThanOrEqual(8)
    expect(files(join(into, 'Local Extension Settings', ALLOWED))).toHaveLength(300)
  })

  it('does not throw for a registry or a prefs file that cannot be read', async () => {
    mkdirSync(join(from, 'extensions'), { recursive: true })
    writeFileSync(join(from, 'extensions', 'registry.json'), '{ not json')
    writeFileSync(join(from, 'extensions', 'prefs.json'), '{ not json')
    expect(await copyPrivateExtensions(from, into, { log })).toEqual([])
    expect(files(into)).toEqual([])
  })

  it('keeps only the choices of today, so a field added later is never carried over', async () => {
    const later = { ...normalizePrefs({ privateWindows: true, pinned: true }), media: { camera: 'allow' } } as unknown as ExtensionPrefs
    const kept = privateCopyOfPrefs(later)
    expect(Object.keys(kept).sort()).toEqual(['granted', 'noticeSeen', 'overrides', 'pinned', 'privateWindows', 'shortcuts', 'siteAccess'])
    expect(kept.pinned).toBe(true)
    expect(kept.privateWindows).toBe(true)
  })

  it('writes the choices of the copied extension through the prefs file\'s own format', async () => {
    profile()
    await copyPrivateExtensions(from, into, { log })
    const prefs = parsePrefsFile(readFileSync(join(into, 'extensions', 'prefs.json'), 'utf8')).get(ALLOWED)
    expect(prefs?.pinned).toBe(true)
    expect(prefs?.noticeSeen).toEqual(['n'])
    expect(prefs?.privateWindows).toBe(true)
  })
})

describe('the data a private session starts with', () => {
  const cache = createHash('sha1').update(`chrome-extension_${ALLOWED}_0`).digest('hex')

  function data (root: string): void {
    put(join(root, 'Local Extension Settings', ALLOWED, 'MANIFEST-000001'), 'm')
    put(join(root, 'Local Extension Settings', ALLOWED, '000003.log'), 'log')
    put(join(root, 'Local Extension Settings', ALLOWED, 'LOCK'), '')
    put(join(root, 'Sync Extension Settings', ALLOWED, '000003.log'), 'sync')
    put(join(root, 'IndexedDB', `chrome-extension_${ALLOWED}_0.indexeddb.leveldb`, 'CURRENT'), 'idb')
    put(join(root, 'IndexedDB', `chrome-extension_${ALLOWED}_0.indexeddb.leveldb`, 'LOCK'), '')
    put(join(root, 'IndexedDB', `chrome-extension_${ALLOWED}_0.indexeddb.blob`, '1', '00', '1'), 'blob')
    put(join(root, 'Service Worker', 'CacheStorage', cache, 'index.txt'), 'cache')
    // Another extension's, and what websites share.
    put(join(root, 'Local Extension Settings', REFUSED, '000003.log'), 'other')
    put(join(root, 'IndexedDB', `chrome-extension_${REFUSED}_0.indexeddb.leveldb`, 'CURRENT'), 'other')
    put(join(root, 'IndexedDB', 'https_example.com_0.indexeddb.leveldb', 'CURRENT'), 'site')
    put(join(root, 'Local Storage', 'leveldb', '000003.log'), `_chrome-extension://${ALLOWED}`)
    put(join(root, 'Service Worker', 'Database', '000003.log'), 'registrations')
    put(join(root, 'Service Worker', 'CacheStorage', 'f'.repeat(40), 'index.txt'), 'site cache')
    for (const shared of ['Cookies', 'History', 'history.db', join('Cache', 'Cache_Data', 'index'), 'Preferences', 'bookmarks.json']) put(join(root, shared), 'shared')
  }

  it('is the extension\'s own storage and nothing a website can also reach', async () => {
    profile()
    data(from)
    await copyPrivateExtensions(from, into, { log })

    expect(files(into).filter((name) => !name.startsWith('extensions/'))).toEqual([
      `IndexedDB/chrome-extension_${ALLOWED}_0.indexeddb.blob/1/00/1`,
      `IndexedDB/chrome-extension_${ALLOWED}_0.indexeddb.leveldb/CURRENT`,
      `Local Extension Settings/${ALLOWED}/000003.log`,
      `Local Extension Settings/${ALLOWED}/MANIFEST-000001`,
      `Service Worker/CacheStorage/${cache}/index.txt`,
      `Sync Extension Settings/${ALLOWED}/000003.log`
    ])
  })

  it('leaves out the LOCK file of a store, which belongs to the process that holds it', async () => {
    profile()
    data(from)
    await copyPrivateExtensions(from, into, { log })
    expect(existsSync(join(into, 'Local Extension Settings', ALLOWED, 'LOCK'))).toBe(false)
    expect(existsSync(join(into, 'IndexedDB', `chrome-extension_${ALLOWED}_0.indexeddb.leveldb`, 'LOCK'))).toBe(false)
  })

  it('is taken from the profile sessions of the tunnels too, and from no other session', async () => {
    profile()
    for (const name of ['tunnel-profile', 'proxy-profile', 'direct-profile']) put(join(from, 'Partitions', name, 'Local Extension Settings', ALLOWED, '000003.log'), name)
    put(join(from, 'Partitions', 'orivon-shell', 'Local Extension Settings', ALLOWED, '000003.log'), 'shell')
    put(join(from, 'Partitions', 'tunnel-profile', 'Cookies'), 'site')
    await copyPrivateExtensions(from, into, { log })

    expect(files(join(into, 'Partitions'))).toEqual([
      `direct-profile/Local Extension Settings/${ALLOWED}/000003.log`,
      `proxy-profile/Local Extension Settings/${ALLOWED}/000003.log`,
      `tunnel-profile/Local Extension Settings/${ALLOWED}/000003.log`
    ])
  })

  it('is not taken through a link', async () => {
    if (process.platform === 'win32') return
    profile()
    put(join(root, 'elsewhere', 'secret'), 'secret')
    mkdirSync(join(from, 'Local Extension Settings'), { recursive: true })
    symlinkSync(join(root, 'elsewhere'), join(from, 'Local Extension Settings', ALLOWED))
    put(join(from, 'extensions', 'allowed', '1.0.0', 'link'), 'x')
    symlinkSync(join(root, 'elsewhere', 'secret'), join(from, 'extensions', 'allowed', '1.0.0', 'secret-link'))
    await copyPrivateExtensions(from, into, { log })
    expect(existsSync(join(into, 'Local Extension Settings'))).toBe(false)
    expect(existsSync(join(into, 'extensions', 'allowed', '1.0.0', 'secret-link'))).toBe(false)
    expect(existsSync(join(into, 'extensions', 'allowed', '1.0.0', 'link'))).toBe(true)
  })

  it('a file that cannot be copied leaves that extension with blank data, logged, and the extension still runs', async () => {
    profile()
    data(from)
    const busy = Object.assign(new Error('resource busy'), { code: 'EBUSY' })
    const copyFile = vi.fn(async (source: string, target: string): Promise<void> => {
      if (source.includes('Local Extension Settings') && source.endsWith('000003.log')) throw busy
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, readFileSync(source))
    })

    await expect(copyPrivateExtensions(from, into, { log, copyFile })).resolves.toEqual([ALLOWED])

    expect(existsSync(join(into, 'Local Extension Settings', ALLOWED))).toBe(false)
    expect(readFileSync(join(into, 'Sync Extension Settings', ALLOWED, '000003.log'), 'utf8')).toBe('sync')
    expect(parseRegistry(readFileSync(join(into, 'extensions', 'registry.json'), 'utf8')).entries.map((item) => item.id)).toEqual([ALLOWED])
    expect(warnings.some((line) => line.includes('EBUSY') && line.includes(ALLOWED))).toBe(true)
  })

  it('an extension whose own files cannot be copied is left out, logged, and the others still come', async () => {
    profile()
    const second = 'e'.repeat(32)
    put(join(from, 'extensions', 'second', '1.0.0', 'manifest.json'), '{}')
    writeFileSync(join(from, 'extensions', 'registry.json'), serializeRegistry([entry(ALLOWED, 'allowed'), entry(second, 'second')]))
    writeFileSync(join(from, 'extensions', 'prefs.json'), serializePrefs(new Map([[ALLOWED, normalizePrefs({ privateWindows: true })], [second, normalizePrefs({ privateWindows: true })]])))
    const copyFile = async (source: string, target: string): Promise<void> => {
      if (source.includes(join('extensions', 'allowed'))) throw Object.assign(new Error('denied'), { code: 'EPERM' })
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, readFileSync(source))
    }

    expect(await copyPrivateExtensions(from, into, { log, copyFile })).toEqual([second])
    expect(existsSync(join(into, 'extensions', 'allowed'))).toBe(false)
    expect(parseRegistry(readFileSync(join(into, 'extensions', 'registry.json'), 'utf8')).entries.map((item) => item.id)).toEqual([second])
    expect(warnings.some((line) => line.includes('EPERM'))).toBe(true)
  })

  it('refuses a registry path that is not inside the profile\'s extensions folder', async () => {
    profile()
    const outside = { ...entry(ALLOWED, 'allowed'), path: join(root, 'elsewhere', '1.0.0') }
    put(join(outside.path, 'manifest.json'), 'x')
    writeFileSync(join(from, 'extensions', 'registry.json'), serializeRegistry([outside]))
    expect(await copyPrivateExtensions(from, into, { log })).toEqual([])
    expect(files(into)).toEqual([])
  })

  it('refuses an id that is not an extension id', async () => {
    profile()
    const bad = { ...entry('../../x', 'allowed') }
    writeFileSync(join(from, 'extensions', 'registry.json'), serializeRegistry([bad]))
    writeFileSync(join(from, 'extensions', 'prefs.json'), serializePrefs(new Map([['../../x', normalizePrefs({ privateWindows: true })]])))
    expect(await copyPrivateExtensions(from, into, { log })).toEqual([])
  })
})
