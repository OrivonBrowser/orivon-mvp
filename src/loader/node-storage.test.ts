import { chmod, mkdir, mkdtemp, readdir as fsReaddir, readFile as fsReadFile, symlink, writeFile as fsWriteFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { nodeLoaderStorage } from './node-storage.js'
import { appRootDirectoryName } from './storage.js'
import { utf8 } from './test-helpers.js'
import { parsePinRecord } from '../broker/policy/pin.js'
import type { PinRecord } from '../broker/policy/pin.js'

// Real temp directory, no mocking -- the same discipline
// broker/node-adapters.test.ts already established for nodeFs, and for the
// same reason (src/broker/README.md): this file has no `electron` import.

const APP = 'https://app.example'

function pinRecord (overrides: Partial<PinRecord> = {}): PinRecord {
  return {
    schema: 1,
    origin: APP,
    bundleHash: 'sha256:' + 'a'.repeat(64),
    assets: [{ path: '/index.html', leaf: 'sha256:' + 'b'.repeat(64) }],
    version: '1.0.0',
    pinnedAt: 0,
    ...overrides
  }
}

describe('nodeLoaderStorage', () => {
  it('readPin returns undefined for an origin never pinned', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)

    expect(await storage.readPin(APP)).toBeUndefined()
  })

  // A corrupt pin file (truncated write mid-crash, a full disk) is NOT the
  // same situation as an origin that was never pinned -- index.ts's load()
  // treats a `readPin` result of undefined as fresh TOFU with zero
  // reconsent check, which is exactly wrong here: this origin WAS pinned
  // once. Real bytes, written directly (never through storage.writePin, so
  // this exercises exactly what a crash mid-write would leave behind), not
  // a mock.
  it('readPin does not return undefined for a pin file that exists but is not valid JSON', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)
    const appDir = join(userData, 'apps', appRootDirectoryName(APP))
    await mkdir(appDir, { recursive: true })
    await fsWriteFile(join(appDir, 'pin.json'), '{"schema": 1, "origin": "https://app.example", "bundle')

    const result = await storage.readPin(APP)

    expect(result).not.toBeUndefined()
    // The caller-visible consequence (index.ts's own safe path): a
    // non-undefined-but-corrupt value must fail parsePinRecord's validation,
    // never partially validate.
    expect(parsePinRecord(result)).toBeNull()
  })

  it('writePin then readPin round-trips the record', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)
    const record = pinRecord()

    await storage.writePin(APP, record)

    expect(await storage.readPin(APP)).toEqual(record)
  })

  it('writePin overwrites whatever was there before', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)

    await storage.writePin(APP, pinRecord({ version: '1.0.0' }))
    await storage.writePin(APP, pinRecord({ version: '2.0.0' }))

    expect(await storage.readPin(APP)).toMatchObject({ version: '2.0.0' })
  })

  it('the pin file is stored OUTSIDE the code root -- ADR-0009: it must not itself be a hashed leaf', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)
    await storage.writePin(APP, pinRecord())
    await storage.writeAsset(APP, '/index.html', new TextEncoder().encode('<html></html>'))

    const codeRoot = join(userData, 'apps', appRootDirectoryName(APP), 'code')
    // Reading the pin file back via a raw fs call proves it did not land
    // inside codeRoot -- if it had, this same-named file would exist there.
    await expect(fsReadFile(join(codeRoot, 'pin.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writeAsset then a raw filesystem read round-trips the exact bytes', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)
    const bytes = new Uint8Array([1, 2, 3, 4])

    await storage.writeAsset(APP, '/app.js', bytes)

    const codeRoot = join(userData, 'apps', appRootDirectoryName(APP), 'code')
    expect(await fsReadFile(join(codeRoot, 'app.js'))).toEqual(Buffer.from(bytes))
  })

  it('writeAsset creates parent directories for a nested path', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)

    await storage.writeAsset(APP, '/css/style.css', new TextEncoder().encode('body{}'))

    const codeRoot = join(userData, 'apps', appRootDirectoryName(APP), 'code')
    expect(await fsReadFile(join(codeRoot, 'css', 'style.css'))).toEqual(Buffer.from('body{}'))
  })

  it('writeAsset percent-decodes before writing, so a space-containing filename lands correctly', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)

    await storage.writeAsset(APP, '/my%20app.html', new TextEncoder().encode('hi'))

    const codeRoot = join(userData, 'apps', appRootDirectoryName(APP), 'code')
    expect(await fsReadFile(join(codeRoot, 'my app.html'))).toEqual(Buffer.from('hi'))
  })

  // Defence in depth (this file's own header): writeAsset's caller already
  // guarantees a validated canonical path, but confinement re-checks anyway
  // rather than trusting that guarantee blindly -- the same stance every
  // other confined write in this codebase takes.
  it('writeAsset rejects a path that would escape the code root, even though callers should never send one', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)

    await expect(storage.writeAsset(APP, '/../../etc/passwd', new Uint8Array())).rejects.toThrow()
  })

  it('pruneAssets deletes a file whose canonical path is not in the keep list', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)
    await storage.writeAsset(APP, '/index.html', utf8('a'))
    await storage.writeAsset(APP, '/old.js', utf8('stale'))

    await storage.pruneAssets(APP, ['/index.html'])

    const codeRoot = join(userData, 'apps', appRootDirectoryName(APP), 'code')
    expect(await fsReadFile(join(codeRoot, 'index.html'), 'utf8')).toBe('a')
    await expect(fsReadFile(join(codeRoot, 'old.js'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('pruneAssets keeps every file whose canonical path is in the keep list', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)
    await storage.writeAsset(APP, '/index.html', utf8('a'))
    await storage.writeAsset(APP, '/app.js', utf8('b'))

    await storage.pruneAssets(APP, ['/index.html', '/app.js'])

    const codeRoot = join(userData, 'apps', appRootDirectoryName(APP), 'code')
    expect(await fsReadFile(join(codeRoot, 'index.html'), 'utf8')).toBe('a')
    expect(await fsReadFile(join(codeRoot, 'app.js'), 'utf8')).toBe('b')
  })

  it('pruneAssets deletes a stale file under a nested directory', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)
    await storage.writeAsset(APP, '/index.html', utf8('a'))
    await storage.writeAsset(APP, '/css/old-style.css', utf8('stale'))

    await storage.pruneAssets(APP, ['/index.html'])

    const codeRoot = join(userData, 'apps', appRootDirectoryName(APP), 'code')
    await expect(fsReadFile(join(codeRoot, 'css', 'old-style.css'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('pruneAssets keeps a file whose keep-list entry is a different Unicode normal form of the same name (B5)', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)
    const precomposed = '/café.html' // single codepoint 'é' (U+00E9), the NFC form
    const decomposed = precomposed.normalize('NFD') // 'e' + U+0301 combining acute accent
    expect(decomposed).not.toBe(precomposed) // sanity: genuinely different byte sequences
    await storage.writeAsset(APP, precomposed, utf8('menu'))

    // Real trigger (HFS+/APFS, a supported run-from-source target): a file
    // written under one Unicode normal form is read back by readdir() under
    // the other, so the keep set and the on-disk walk never string-match.
    // Reproduced here without a real such filesystem by writing under one
    // form and pruning against the other -- the byte mismatch this produces
    // is the same one a real macOS readdir() would hand back.
    await storage.pruneAssets(APP, [decomposed])

    const codeRoot = join(userData, 'apps', appRootDirectoryName(APP), 'code')
    await expect(fsReadFile(join(codeRoot, 'café.html'), 'utf8')).resolves.toBe('menu')
  })

  // macOS APFS and Windows NTFS are case-INSENSITIVE but case-PRESERVING by
  // default, and both are supported run-from-source targets (CLAUDE.md Rule
  // 8). A bundle update that changes only an asset path's case rewrites the
  // SAME physical file there, but readdir still reports its original
  // spelling -- which never string-matches the new manifest's keep entry, so
  // the file just written is immediately deleted. Reproduced here on a
  // case-sensitive filesystem by writing under one spelling and pruning
  // against the other, which is the byte mismatch a real APFS readdir hands
  // back.
  it('pruneAssets keeps a file whose keep-list entry differs from the on-disk name only in case', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)
    await storage.writeAsset(APP, '/App.js', utf8('live'))

    await storage.pruneAssets(APP, ['/app.js'])

    const codeRoot = join(userData, 'apps', appRootDirectoryName(APP), 'code')
    await expect(fsReadFile(join(codeRoot, 'App.js'), 'utf8')).resolves.toBe('live')
  })

  it('pruneAssets removes a directory left empty once its only file is pruned', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)
    await storage.writeAsset(APP, '/index.html', utf8('a'))
    await storage.writeAsset(APP, '/css/old-style.css', utf8('stale'))

    await storage.pruneAssets(APP, ['/index.html'])

    const codeRoot = join(userData, 'apps', appRootDirectoryName(APP), 'code')
    await expect(fsReaddir(join(codeRoot, 'css'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('pruneAssets removes a whole chain of directories its own deletions left empty', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)
    await storage.writeAsset(APP, '/index.html', utf8('a'))
    await storage.writeAsset(APP, '/vendor/old/lib/legacy.js', utf8('stale'))
    await storage.writeAsset(APP, '/vendor/dropped.js', utf8('stale too'))

    await storage.pruneAssets(APP, ['/index.html'])

    const codeRoot = join(userData, 'apps', appRootDirectoryName(APP), 'code')
    await expect(fsReaddir(join(codeRoot, 'vendor'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fsReaddir(codeRoot)).toEqual(['index.html'])
  })

  // The interleaving, performed by hand rather than raced: a concurrent
  // install's writeAsset does mkdir(code/js/) and has not reached its
  // writeFile yet. Nothing in the loader removed a directory before
  // pruneAssets existed, so a sweep that removes ANY empty directory turns
  // that window into an ENOENT on a write already in flight -- a hard
  // failure this file introduced (docs/open-questions.md A62). Only
  // directories this prune itself emptied are removed.
  it('pruneAssets leaves an empty directory it did not empty itself, so a concurrent write into it still lands', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)
    await storage.writeAsset(APP, '/index.html', utf8('a'))
    const codeRoot = join(userData, 'apps', appRootDirectoryName(APP), 'code')
    await mkdir(join(codeRoot, 'js'), { recursive: true })

    await storage.pruneAssets(APP, ['/index.html'])

    await expect(fsReaddir(join(codeRoot, 'js'))).resolves.toEqual([])
    // ...and the write that mkdir was preparing for still succeeds.
    await storage.writeAsset(APP, '/js/app.js', utf8('b'))
    await expect(fsReadFile(join(codeRoot, 'js', 'app.js'), 'utf8')).resolves.toBe('b')
  })

  it('pruneAssets never removes the code root itself, even when everything is pruned', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)
    await storage.writeAsset(APP, '/old.js', utf8('stale'))

    await storage.pruneAssets(APP, [])

    const codeRoot = join(userData, 'apps', appRootDirectoryName(APP), 'code')
    expect(await fsReaddir(codeRoot)).toEqual([])
  })

  it('pruneAssets logs and continues past one file it cannot delete, rather than aborting the whole prune', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)
    await storage.writeAsset(APP, '/index.html', utf8('a'))
    await storage.writeAsset(APP, '/locked/old.css', utf8('stale'))
    await storage.writeAsset(APP, '/old.js', utf8('stale too'))

    const codeRoot = join(userData, 'apps', appRootDirectoryName(APP), 'code')
    // Deleting a file needs write permission on its PARENT directory, not the
    // file itself -- this is what actually makes the rm() below fail with
    // EACCES, unlike chmod-ing the file.
    await chmod(join(codeRoot, 'locked'), 0o555)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(storage.pruneAssets(APP, ['/index.html'])).resolves.toBeUndefined()
    const logCalls = logged.mock.calls.length
    logged.mockRestore()
    await chmod(join(codeRoot, 'locked'), 0o755) // so a later run can clean up /tmp

    expect(logCalls).toBeGreaterThan(0)
    // The undeletable file is still there...
    await expect(fsReadFile(join(codeRoot, 'locked', 'old.css'))).resolves.toBeDefined()
    // ...but the OTHER stale file was still removed: one failure did not stop
    // the loop, and index.ts's install() still calls writePin right after.
    await expect(fsReadFile(join(codeRoot, 'old.js'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // One call EARLIER than the rm() hardened above: the walk's own readdir.
  // An exception here propagates out of pruneAssets and aborts install()
  // between "new bundle fully written" and "pin record written" -- the exact
  // disk state the next load() reads back as never-pinned fresh TOFU.
  it('pruneAssets logs and continues past a subdirectory it cannot list, rather than aborting the whole prune', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)
    await storage.writeAsset(APP, '/index.html', utf8('a'))
    await storage.writeAsset(APP, '/sealed/hidden.css', utf8('unreachable'))
    await storage.writeAsset(APP, '/old.js', utf8('stale'))

    const codeRoot = join(userData, 'apps', appRootDirectoryName(APP), 'code')
    // No read permission at all, so readdir() fails outright -- unlike the
    // 0o555 above, which leaves the directory listable and only blocks the
    // delete.
    await chmod(join(codeRoot, 'sealed'), 0o000)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(storage.pruneAssets(APP, ['/index.html'])).resolves.toBeUndefined()
    const logCalls = logged.mock.calls.length
    logged.mockRestore()
    await chmod(join(codeRoot, 'sealed'), 0o755) // so a later run can clean up /tmp

    expect(logCalls).toBeGreaterThan(0)
    // The unlistable subtree is untouched...
    await expect(fsReadFile(join(codeRoot, 'sealed', 'hidden.css'), 'utf8')).resolves.toBe('unreachable')
    // ...and the rest of the tree was still pruned.
    await expect(fsReadFile(join(codeRoot, 'old.js'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('pruneAssets is a no-op for an origin with nothing on disk yet', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)

    await expect(storage.pruneAssets(APP, ['/index.html'])).resolves.toBeUndefined()
  })

  // A symlink planted at `code` BEFORE this origin's first install is the
  // one case pure path arithmetic cannot catch: mkdirSync(root, {recursive:
  // true}) succeeds silently against an existing symlink-to-directory, and
  // confinePath then realpaths that symlink and confines to its TARGET.
  // Both tests plant a real symlink to a real directory holding a marker
  // file, exactly as an attacker with write access to userData would.
  async function plantSymlinkedCodeRoot (): Promise<{ userData: string, outside: string }> {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const outside = await mkdtemp(join(tmpdir(), 'orivon-outside-'))
    await fsWriteFile(join(outside, 'unrelated.txt'), 'not Orivon\'s to touch')
    const appDir = join(userData, 'apps', appRootDirectoryName(APP))
    await mkdir(appDir, { recursive: true })
    await symlink(outside, join(appDir, 'code'), 'dir')
    return { userData, outside }
  }

  it('pruneAssets refuses a symlinked code root instead of deleting through it', async () => {
    const { userData, outside } = await plantSymlinkedCodeRoot()
    const storage = nodeLoaderStorage(userData)

    await expect(storage.pruneAssets(APP, [])).rejects.toThrow(/not a directory Orivon created/)

    await expect(fsReadFile(join(outside, 'unrelated.txt'), 'utf8')).resolves.toBe('not Orivon\'s to touch')
  })

  it('writeAsset refuses a symlinked code root instead of writing through it', async () => {
    const { userData, outside } = await plantSymlinkedCodeRoot()
    const storage = nodeLoaderStorage(userData)

    await expect(storage.writeAsset(APP, '/planted.js', utf8('x'))).rejects.toThrow(/not a directory Orivon created/)

    await expect(fsReadFile(join(outside, 'planted.js'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // The symlink is REFUSED, never removed: deleting an attacker-controlled
  // path on an attacker-chosen schedule is its own hazard.
  it('a refused symlinked code root is left in place, not deleted', async () => {
    const { userData, outside } = await plantSymlinkedCodeRoot()
    const storage = nodeLoaderStorage(userData)

    await expect(storage.writeAsset(APP, '/planted.js', utf8('x'))).rejects.toThrow()

    const code = join(userData, 'apps', appRootDirectoryName(APP), 'code')
    expect(await fsReaddir(code)).toEqual(['unrelated.txt'])
    expect(outside).toBeDefined()
  })

  it('two different origins get two different code roots', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-storage-'))
    const storage = nodeLoaderStorage(userData)

    await storage.writeAsset(APP, '/index.html', new TextEncoder().encode('a'))
    await storage.writeAsset('https://other.example', '/index.html', new TextEncoder().encode('b'))

    const rootA = join(userData, 'apps', appRootDirectoryName(APP), 'code', 'index.html')
    const rootB = join(userData, 'apps', appRootDirectoryName('https://other.example'), 'code', 'index.html')
    expect(await fsReadFile(rootA, 'utf8')).toBe('a')
    expect(await fsReadFile(rootB, 'utf8')).toBe('b')
  })
})
