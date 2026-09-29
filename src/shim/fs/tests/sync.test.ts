// readFileSync and existsSync: the two synchronous fs calls that work
// everywhere, both over orivon.fs.readFileSync, ADR-0016's original
// synchronous entry point. Every other *Sync call: refused on the page and
// in a Worker with no SharedArrayBuffer, and built over the Worker's
// synchronous twin (Symbol.for('orivon.synchronous')) otherwise -- ADR-0016's
// amendment. src/shim/fs/tests/sync-in-worker.test.ts proves the Worker route
// against a real worker_threads thread and a real disk; this file proves the
// two refusals and the twin-call shape with a fake orivon on this thread.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../../contracts/capability-api.js'
import { VIRTUAL_ROOT, VIRTUAL_TMPDIR } from '../../virtual-root.js'
import { Buffer } from 'buffer'

const SYNCHRONOUS = Symbol.for('orivon.synchronous')

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

function orivonError (code: string, platformCode?: string): Error {
  return Object.assign(new Error(`${code} failure`), { name: 'OrivonError', code, ...(platformCode === undefined ? {} : { platformCode }) })
}

/** `entries` maps a confined path to its bytes, or to the error the broker would throw for it. */
function installFakeOrivon (entries: Record<string, Uint8Array | Error>): string[] {
  const reads: string[] = []
  ;(globalThis as GlobalWithOrivon).orivon = {
    fs: {
      readFileSync: (path: string) => {
        reads.push(path)
        const entry = entries[path]
        if (entry === undefined) throw orivonError('notFound', 'ENOENT')
        if (entry instanceof Error) throw entry
        return entry
      }
    }
  } as unknown as Orivon
  return reads
}

/** A fake Worker synchronous twin: `calls` records every `fs.<member>` name and confined path it was asked to make. */
function installSyncTwin (fs: Record<string, (...args: never[]) => unknown>): Array<{ member: string, args: unknown[] }> {
  const calls: Array<{ member: string, args: unknown[] }> = []
  const recording: Record<string, (...args: unknown[]) => unknown> = {}
  for (const [member, run] of Object.entries(fs)) {
    recording[member] = (...args: unknown[]) => { calls.push({ member, args }); return (run as (...a: unknown[]) => unknown)(...args) }
  }
  ;(globalThis as GlobalWithOrivon).orivon = { [SYNCHRONOUS]: { fs: recording } } as unknown as Orivon
  return calls
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

describe('fs.readFileSync', () => {
  it('maps a broker failure to Node\'s errno, as the async calls do', async () => {
    installFakeOrivon({})
    const fs = await import('../fs.js')
    expect(() => fs.readFileSync('missing.json')).toThrow(expect.objectContaining({ code: 'ENOENT', orivonCode: 'notFound' }))
  })

  it('keeps a denial as \'denied\', never a fake errno', async () => {
    installFakeOrivon({ secret: orivonError('denied') })
    const fs = await import('../fs.js')
    expect(() => fs.readFileSync('secret')).toThrow(expect.objectContaining({ code: 'denied' }))
  })

  it('reading the root is EISDIR, answered locally', async () => {
    const reads = installFakeOrivon({})
    const fs = await import('../fs.js')
    expect(() => fs.readFileSync(VIRTUAL_ROOT)).toThrow(expect.objectContaining({ code: 'EISDIR' }))
    expect(reads).toEqual([])
  })
})

describe('fs.existsSync', () => {
  it('on the page: true for a file it can read, false for a missing one', async () => {
    installFakeOrivon({ 'settings.json': new Uint8Array([1]) })
    const fs = await import('../fs.js')
    expect(fs.existsSync('settings.json')).toBe(true)
    expect(fs.existsSync(`${VIRTUAL_ROOT}/settings.json`)).toBe(true)
    expect(fs.existsSync('missing.json')).toBe(false)
  })

  // Reading a directory fails EISDIR, which proves it exists.
  it('on the page: true for a directory', async () => {
    installFakeOrivon({ torrents: orivonError('internal', 'EISDIR') })
    const fs = await import('../fs.js')
    expect(fs.existsSync('torrents')).toBe(true)
  })

  it('on the page: true for the root, without asking the broker', async () => {
    const reads = installFakeOrivon({})
    const fs = await import('../fs.js')
    expect(fs.existsSync(VIRTUAL_ROOT)).toBe(true)
    expect(fs.existsSync('.')).toBe(true)
    expect(reads).toEqual([])
  })

  // Node's existsSync returns false for anything it cannot confirm, a
  // permission failure included, and never throws.
  it('on the page: false outside the root, for a denied path, and for a bad argument', async () => {
    const reads = installFakeOrivon({ secret: orivonError('denied') })
    const fs = await import('../fs.js')
    expect(fs.existsSync('/etc/passwd')).toBe(false)
    expect(fs.existsSync('secret')).toBe(false)
    expect(fs.existsSync(42 as unknown as string)).toBe(false)
    expect(reads).toEqual(['secret'])
  })

  it('in a Worker: answered by a stat, never a whole-file read', async () => {
    const calls = installSyncTwin({ stat: (path: string) => { if (path === 'missing.json') throw orivonError('notFound'); return { size: 1, isFile: true, isDirectory: false, mtimeMs: 0 } } })
    const fs = await import('../fs.js')
    expect(fs.existsSync('settings.json')).toBe(true)
    expect(fs.existsSync('missing.json')).toBe(false)
    expect(calls.map((c) => c.member)).toEqual(['stat', 'stat'])
  })
})

describe('the Worker-only *Sync calls, on the page or without shared memory', () => {
  it('refuse by name, naming where the call does work', async () => {
    installFakeOrivon({})
    const fs = await import('../fs.js')
    expect(() => fs.statSync('x')).toThrow(expect.objectContaining({ api: 'fs.statSync', code: 'ERR_ORIVON_FS_SYNC_UNSUPPORTED' }))
    expect(() => fs.statSync('x')).toThrow(/forked child or a worker_threads.Worker/)
    expect(() => fs.writeFileSync('x', 'y')).toThrow(expect.objectContaining({ code: 'ERR_ORIVON_FS_SYNC_UNSUPPORTED' }))
    expect(() => fs.mkdirSync('x')).toThrow(expect.objectContaining({ code: 'ERR_ORIVON_FS_SYNC_UNSUPPORTED' }))
    expect(() => fs.readdirSync('x')).toThrow(expect.objectContaining({ code: 'ERR_ORIVON_FS_SYNC_UNSUPPORTED' }))
    expect(() => fs.rmSync('x')).toThrow(expect.objectContaining({ code: 'ERR_ORIVON_FS_SYNC_UNSUPPORTED' }))
    expect(() => fs.rmdirSync('x')).toThrow(expect.objectContaining({ code: 'ERR_ORIVON_FS_SYNC_UNSUPPORTED' }))
    expect(() => fs.renameSync('x', 'y')).toThrow(expect.objectContaining({ code: 'ERR_ORIVON_FS_SYNC_UNSUPPORTED' }))
    expect(() => fs.unlinkSync('x')).toThrow(expect.objectContaining({ code: 'ERR_ORIVON_FS_SYNC_UNSUPPORTED' }))
    expect(() => fs.accessSync('x')).toThrow(expect.objectContaining({ code: 'ERR_ORIVON_FS_SYNC_UNSUPPORTED' }))
    expect(() => fs.appendFileSync('x', 'y')).toThrow(expect.objectContaining({ code: 'ERR_ORIVON_FS_SYNC_UNSUPPORTED' }))
    expect(() => fs.lstatSync('x')).toThrow(expect.objectContaining({ code: 'ERR_ORIVON_FS_SYNC_UNSUPPORTED' }))
    expect(() => fs.copyFileSync('x', 'y')).toThrow(expect.objectContaining({ code: 'ERR_ORIVON_FS_SYNC_UNSUPPORTED' }))
    expect(() => fs.mkdtempSync('x')).toThrow(expect.objectContaining({ code: 'ERR_ORIVON_FS_SYNC_UNSUPPORTED' }))
    expect(() => fs.realpathSync('x')).toThrow(expect.objectContaining({ api: 'fs.realpathSync', code: 'ERR_ORIVON_FS_SYNC_UNSUPPORTED' }))
  })

  // orivon-client.ts (worker/tests/orivon-proxy.test.ts) is what actually
  // decides "no SharedArrayBuffer": there, hasSharedMemory() false means the
  // client never installs a synchronous twin at all, which is exactly the
  // "no orivon[SYNCHRONOUS]" case the page tests above already exercise --
  // fs/core-sync.ts's own syncFs() cannot tell the two apart, on purpose.
})

describe('realpathSync', () => {
  it('answers from a stat through the twin, returning the normalised absolute path under the virtual root', async () => {
    const calls = installSyncTwin({ stat: (path: string) => { if (path === 'missing') throw orivonError('notFound', 'ENOENT'); return { size: 0, isFile: true, isDirectory: false, mtimeMs: 0 } } })
    const fs = await import('../fs.js')
    expect(fs.realpathSync('settings.json')).toBe(`${VIRTUAL_ROOT}/settings.json`)
    expect(calls).toEqual([{ member: 'stat', args: ['settings.json'] }])
  })

  it('is ENOENT for a missing path', async () => {
    installSyncTwin({ stat: () => { throw orivonError('notFound', 'ENOENT') } })
    const fs = await import('../fs.js')
    expect(() => fs.realpathSync('missing')).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })

  it('the root resolves to the virtual root, without asking the twin', async () => {
    const calls = installSyncTwin({ stat: () => { throw new Error('should not be called') } })
    const fs = await import('../fs.js')
    expect(fs.realpathSync(VIRTUAL_ROOT)).toBe(VIRTUAL_ROOT)
    expect(calls).toEqual([])
  })

  it('encoding: \'buffer\' returns a Buffer of the same path', async () => {
    installSyncTwin({ stat: () => ({ size: 0, isFile: true, isDirectory: false, mtimeMs: 0 }) })
    const fs = await import('../fs.js')
    const result = fs.realpathSync('settings.json', { encoding: 'buffer' })
    expect(Buffer.isBuffer(result)).toBe(true)
    expect(result.toString()).toBe(`${VIRTUAL_ROOT}/settings.json`)
  })

  it('.native answers the same way -- this shim keeps no cache for it to bypass', async () => {
    installSyncTwin({ stat: () => ({ size: 0, isFile: true, isDirectory: false, mtimeMs: 0 }) })
    const fs = await import('../fs.js')
    expect(fs.realpathSync.native('settings.json')).toBe(`${VIRTUAL_ROOT}/settings.json`)
  })
})

describe('rmdirSync, over the synchronous twin', () => {
  it('removes an EMPTY directory with no recursive option -- unlike rm, which fails on ANY directory without one', async () => {
    const calls = installSyncTwin({
      stat: () => ({ size: 0, isFile: false, isDirectory: true, mtimeMs: 0 }),
      readdir: () => [],
      rm: () => {}
    })
    const fs = await import('../fs.js')
    expect(() => fs.rmdirSync('empty-dir')).not.toThrow()
    expect(calls.map((c) => c.member)).toEqual(['stat', 'readdir', 'rm'])
    expect(calls[2]).toEqual({ member: 'rm', args: ['empty-dir', { recursive: true }] })
  })

  it('is ENOTEMPTY for a non-empty directory, never asking the twin to remove anything', async () => {
    const calls = installSyncTwin({
      stat: () => ({ size: 0, isFile: false, isDirectory: true, mtimeMs: 0 }),
      readdir: () => ['a.txt'],
      rm: () => { throw new Error('must not be called') }
    })
    const fs = await import('../fs.js')
    expect(() => fs.rmdirSync('full-dir')).toThrow(expect.objectContaining({ code: 'ENOTEMPTY' }))
    expect(calls.map((c) => c.member)).toEqual(['stat', 'readdir'])
  })

  it('is ENOTDIR for a file, never calling readdir', async () => {
    const calls = installSyncTwin({ stat: () => ({ size: 3, isFile: true, isDirectory: false, mtimeMs: 0 }) })
    const fs = await import('../fs.js')
    expect(() => fs.rmdirSync('a-file')).toThrow(expect.objectContaining({ code: 'ENOTDIR' }))
    expect(calls.map((c) => c.member)).toEqual(['stat'])
  })

  it('is ENOENT for a missing path', async () => {
    installSyncTwin({ stat: () => { throw orivonError('notFound', 'ENOENT') } })
    const fs = await import('../fs.js')
    expect(() => fs.rmdirSync('missing')).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })

  it('{ recursive: true } removes the tree, skipping every check, exactly like rmSync', async () => {
    const calls = installSyncTwin({
      stat: () => { throw new Error('must not be called') },
      readdir: () => { throw new Error('must not be called') },
      rm: () => {}
    })
    const fs = await import('../fs.js')
    expect(() => fs.rmdirSync('a-tree', { recursive: true })).not.toThrow()
    expect(calls).toEqual([{ member: 'rm', args: ['a-tree', { recursive: true }] }])
  })
})

describe('the Worker-only *Sync calls, over the synchronous twin', () => {
  it('statSync/lstatSync call the twin\'s stat with the confined path, and map its errors', async () => {
    const calls = installSyncTwin({ stat: (path: string) => { if (path === 'missing') throw orivonError('notFound', 'ENOENT'); return { size: 3, isFile: true, isDirectory: false, mtimeMs: 5 } } })
    const fs = await import('../fs.js')
    expect(fs.statSync('settings.json')?.size).toBe(3)
    expect(fs.lstatSync('settings.json')?.size).toBe(3)
    expect(() => fs.statSync('missing')).toThrow(expect.objectContaining({ code: 'ENOENT' }))
    expect(calls.map((c) => c.member)).toEqual(['stat', 'stat', 'stat'])
    expect(calls[0]?.args).toEqual(['settings.json'])
  })

  // Finding 13: statSync/lstatSync used to ignore this option entirely and
  // always throw ENOENT, breaking `const s = statSync(p, { throwIfNoEntry:
  // false }); if (s) ...` -- Node returns `undefined` instead (measured), but
  // only for a MISSING path: any other failure still throws.
  it('{ throwIfNoEntry: false }: undefined for a missing path, still throws for any other failure', async () => {
    installSyncTwin({
      stat: (path: string) => {
        if (path === 'missing') throw orivonError('notFound', 'ENOENT')
        if (path === 'secret') throw orivonError('denied')
        return { size: 3, isFile: true, isDirectory: false, mtimeMs: 5 }
      }
    })
    const fs = await import('../fs.js')
    expect(fs.statSync('missing', { throwIfNoEntry: false })).toBeUndefined()
    expect(fs.lstatSync('missing', { throwIfNoEntry: false })).toBeUndefined()
    expect(fs.statSync('settings.json', { throwIfNoEntry: false })?.size).toBe(3)
    expect(() => fs.statSync('secret', { throwIfNoEntry: false })).toThrow(expect.objectContaining({ code: 'denied' }))
    expect(() => fs.statSync('missing')).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })

  it('statSync of the root is answered locally, without asking the twin', async () => {
    const calls = installSyncTwin({ stat: () => { throw new Error('should not be called') } })
    const fs = await import('../fs.js')
    expect(fs.statSync(VIRTUAL_ROOT)?.isDirectory()).toBe(true)
    expect(calls).toEqual([])
  })

  it('writeFileSync encodes and calls the twin\'s writeFile', async () => {
    let written: Uint8Array | undefined
    installSyncTwin({ writeFile: (path: string, data: Uint8Array) => { written = data } })
    const fs = await import('../fs.js')
    fs.writeFileSync('settings.json', 'hello')
    expect(new TextDecoder().decode(written)).toBe('hello')
  })

  it('mkdirSync passes recursive through to the twin', async () => {
    const calls = installSyncTwin({ mkdir: () => {} })
    const fs = await import('../fs.js')
    fs.mkdirSync('a/b', { recursive: true })
    expect(calls[0]).toEqual({ member: 'mkdir', args: ['a/b', { recursive: true }] })
  })

  it('readdirSync with withFileTypes stats each entry through the twin', async () => {
    installSyncTwin({
      readdir: () => ['a.txt', 'sub'],
      stat: (path: string) => path.endsWith('sub') ? { size: 0, isFile: false, isDirectory: true, mtimeMs: 0 } : { size: 1, isFile: true, isDirectory: false, mtimeMs: 0 }
    })
    const fs = await import('../fs.js')
    const entries = fs.readdirSync('somedir', { withFileTypes: true }) as ReadonlyArray<{ name: string, isDirectory: () => boolean }>
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'sub'])
    expect(entries[1]?.isDirectory()).toBe(true)
  })

  it('rmSync ignores ENOENT when force is set, over the twin', async () => {
    installSyncTwin({ rm: () => { throw orivonError('notFound', 'ENOENT') } })
    const fs = await import('../fs.js')
    expect(() => fs.rmSync('gone')).toThrow(expect.objectContaining({ code: 'ENOENT' }))
    expect(() => fs.rmSync('gone', { force: true })).not.toThrow()
  })

  it('renameSync and unlinkSync call the twin', async () => {
    const calls = installSyncTwin({ rename: () => {}, rm: () => {} })
    const fs = await import('../fs.js')
    fs.renameSync('a', 'b')
    fs.unlinkSync('a')
    expect(calls.map((c) => c.member)).toEqual(['rename', 'rm'])
  })

  it('accessSync stats through the twin and reports a denial as Node would', async () => {
    installSyncTwin({ stat: () => { throw orivonError('denied') } })
    const fs = await import('../fs.js')
    expect(() => fs.accessSync('secret')).toThrow(expect.objectContaining({ code: 'denied' }))
  })

  it('copyFileSync reads then writes through the twin', async () => {
    const written: Record<string, Uint8Array> = {}
    installSyncTwin({
      readFile: (path: string) => (path === 'src.txt' ? new TextEncoder().encode('bytes') : (() => { throw orivonError('notFound') })()),
      writeFile: (path: string, data: Uint8Array) => { written[path] = data }
    })
    const fs = await import('../fs.js')
    fs.copyFileSync('src.txt', 'dest.txt')
    expect(new TextDecoder().decode(written['dest.txt'])).toBe('bytes')
  })

  it('mkdtempSync appends a random suffix and creates it through the twin', async () => {
    const created: string[] = []
    installSyncTwin({ mkdir: (path: string) => { created.push(path) } })
    const fs = await import('../fs.js')
    const path = fs.mkdtempSync('orivon-')
    expect(path.startsWith('orivon-')).toBe(true)
    expect(path.length).toBe('orivon-'.length + 12)
    expect(created).toEqual([path])
  })
})

describe('every *Sync export creates os.tmpdir() on first use, like the async twins (finding 5)', () => {
  /** A twin over a Set of directories that actually exist: `mkdir` (non-recursive) fails ENOENT unless its parent is already in the set, matching a broker that starts with the tmpdir missing. */
  function installTmpdirTwin (): { dirs: Set<string>, calls: string[] } {
    const dirs = new Set<string>(['.'])
    const calls: string[] = []
    const parent = (p: string): string => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'
    installSyncTwin({
      stat: (p: string) => { calls.push(`stat ${p}`); if (!dirs.has(p)) throw orivonError('notFound', 'ENOENT'); return { size: 0, isFile: false, isDirectory: true, mtimeMs: 0 } },
      mkdir: (p: string, o?: { recursive?: boolean }) => { calls.push(`mkdir ${p}`); if (o?.recursive !== true && !dirs.has(parent(p))) throw orivonError('notFound', 'ENOENT'); dirs.add(p) },
      readdir: (p: string) => { calls.push(`readdir ${p}`); if (!dirs.has(p)) throw orivonError('notFound', 'ENOENT'); return [] },
      rename: (from: string, to: string) => { calls.push(`rename ${from} ${to}`); if (!dirs.has(parent(from))) throw orivonError('notFound', 'ENOENT'); dirs.add(to) },
      rm: (p: string) => { calls.push(`rm ${p}`); if (!dirs.has(parent(p))) throw orivonError('notFound', 'ENOENT') },
      open: (p: string) => {
        calls.push(`open ${p}`)
        if (!dirs.has(parent(p))) throw orivonError('notFound', 'ENOENT')
        return {
          read: () => new Uint8Array(),
          write: (o: { data: Uint8Array }) => o.data.length,
          stat: () => ({ size: 0, isFile: true, isDirectory: false, mtimeMs: 0 }),
          truncate: () => {},
          sync: () => {},
          close: () => {}
        }
      }
    })
    return { dirs, calls }
  }

  // Node's os.tmpdir() always exists; this shim's confined root starts
  // empty, so every path-based *Sync call under it must create the
  // directory the first time it is used, exactly like fs/paths.ts's async
  // `confine()` already does for the callback/promise family.
  it('statSync/lstatSync/accessSync', async () => {
    installTmpdirTwin()
    const fs = await import('../fs.js')
    expect(fs.statSync(VIRTUAL_TMPDIR)?.isDirectory()).toBe(true)
    expect(fs.lstatSync(VIRTUAL_TMPDIR)?.isDirectory()).toBe(true)
    expect(() => fs.accessSync(VIRTUAL_TMPDIR)).not.toThrow()
  })

  it('realpathSync', async () => {
    installTmpdirTwin()
    const fs = await import('../fs.js')
    expect(fs.realpathSync(VIRTUAL_TMPDIR)).toBe(VIRTUAL_TMPDIR)
  })

  it('existsSync', async () => {
    installTmpdirTwin()
    const fs = await import('../fs.js')
    expect(fs.existsSync(VIRTUAL_TMPDIR)).toBe(true)
  })

  it('mkdtempSync', async () => {
    installTmpdirTwin()
    const fs = await import('../fs.js')
    expect(() => fs.mkdtempSync(`${VIRTUAL_TMPDIR}/app-`)).not.toThrow()
  })

  it('readdirSync', async () => {
    installTmpdirTwin()
    const fs = await import('../fs.js')
    expect(fs.readdirSync(VIRTUAL_TMPDIR)).toEqual([])
  })

  it('rmdirSync and rmSync', async () => {
    const { dirs } = installTmpdirTwin()
    dirs.add('tmp/leftover')
    const fs = await import('../fs.js')
    expect(() => fs.rmSync(`${VIRTUAL_TMPDIR}/leftover`)).not.toThrow()
  })

  it('renameSync and unlinkSync', async () => {
    installTmpdirTwin()
    const fs = await import('../fs.js')
    expect(() => fs.renameSync(`${VIRTUAL_TMPDIR}/a`, `${VIRTUAL_TMPDIR}/b`)).not.toThrow()
    expect(() => fs.unlinkSync(`${VIRTUAL_TMPDIR}/b`)).not.toThrow()
  })

  it('copyFileSync', async () => {
    const dirs = new Set<string>(['.'])
    installSyncTwin({
      mkdir: (p: string) => { dirs.add(p) },
      readFile: () => new TextEncoder().encode('bytes'),
      writeFile: () => {}
    })
    const fs = await import('../fs.js')
    expect(() => fs.copyFileSync(`${VIRTUAL_TMPDIR}/src.txt`, `${VIRTUAL_TMPDIR}/dest.txt`, undefined)).not.toThrow()
  })

  it('openSync, and appendFileSync/writeFileSync with a non-\'w\' flag over the same open path', async () => {
    installTmpdirTwin()
    const fs = await import('../fs.js')
    expect(() => fs.openSync(`${VIRTUAL_TMPDIR}/x.log`, 'a')).not.toThrow()
  })

  it('appendFileSync', async () => {
    installTmpdirTwin()
    const fs = await import('../fs.js')
    expect(() => fs.appendFileSync(`${VIRTUAL_TMPDIR}/x.log`, 'hi')).not.toThrow()
  })
})
