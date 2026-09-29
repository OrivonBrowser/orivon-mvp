import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile as fsReadFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createBroker } from '../../index.js'
import { nodeFs } from '../node-fs-adapter.js'
import { appDataRoot, originHash } from '../../grants/origin-hash.js'

// The real filesystem adapter's own suite -- split out of
// node-adapters.test.ts under code-guidelines.md Rule 2, paired with
// ./node-fs-adapter.ts's own split out of node-adapters.ts. A pure move for
// the first two describe blocks below: no behaviour changed, so the diff
// reads as one. See node-fs-adapter.ts's own header for why this half of
// the adapter layer is now its own file.

describe('nodeFs (the real filesystem adapter)', () => {
  it('rootFor is sha256(origin), never the origin string (T13b)', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)

    const root = fs.rootFor('https://app.example')

    expect(root).not.toContain('app.example')
    expect(root).toMatch(/[0-9a-f]{64}[/\\]files$/)
    // Pins this adapter to origin-hash.ts's frozen construction specifically
    // -- the two assertions above pass for ANY 64-hex scheme (a salted
    // hash, a different algorithm); this one fails if rootFor ever diverges
    // from the shared originHash() partitionFor also derives from.
    expect(root).toContain(originHash('https://app.example'))
  })

  it('writeFile then readFile round-trips, creating parent directories', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const path = join(fs.rootFor('https://app.example'), 'a', 'b.txt')
    const data = new Uint8Array([1, 2, 3])

    await fs.writeFile(path, data)
    const back = await fs.readFile(path)

    expect(back).toEqual(data)
    expect(await fsReadFile(path)).toEqual(Buffer.from(data))
  })

  // This adapter deliberately does NOT classify its own errors.
  // capabilities/fs.ts's mapIoError is the single place an errno becomes an
  // OrivonError, and it passes an already-shaped OrivonError straight
  // through unchanged -- so an adapter that pre-shaped one BYPASSED the
  // mapper rather than helping it. index-fs-extended.test.ts already pins
  // what the mapper then does with these (ENOENT -> notFound + platformCode;
  // EACCES -> denied and no platformCode); those tests used a stub fs, which
  // is why the real adapter's bypass did not show up there.
  it('readFile of a missing file surfaces the raw errno for the broker to map', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)

    await expect(fs.readFile(join(userData, 'missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never raises an OrivonError-shaped failure naming the confined absolute path (T13b)', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const secret = join(fs.rootFor('https://app.example'), 'missing.txt')

    const error = await fs.readFile(secret).then(() => undefined, (e: unknown) => e)

    // A raw Node error names the path -- that is Node's own message, and
    // mapIoError replaces it wholesale. What must never happen is this file
    // handing back something mapIoError will pass through untouched, because
    // that is what reaches the page verbatim.
    expect((error as { name?: string }).name).not.toBe('OrivonError')
  })
})

describe('nodeFs -- the extended fs adapters (queue item 2.1)', () => {
  // These adapters are the raw-I/O half only. Confinement is
  // capabilities/fs.ts's job (confinePath, before any of these ever run) --
  // every path handed to a test below is one this adapter is trusted to
  // touch directly, matching how the readFile/writeFile tests above already
  // work against real absolute paths under `fs.rootFor(...)`.

  it('mkdir creates a directory; recursive:true creates missing parents', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const root = fs.rootFor('https://app.example')

    await fs.mkdir(join(root, 'a'))
    expect(statSync(join(root, 'a')).isDirectory()).toBe(true)

    await fs.mkdir(join(root, 'b', 'c', 'd'), { recursive: true })
    expect(statSync(join(root, 'b', 'c', 'd')).isDirectory()).toBe(true)
  })

  it('mkdir without recursive fails when the parent is missing', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const root = fs.rootFor('https://app.example')

    await expect(fs.mkdir(join(root, 'missing-parent', 'x'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('readdir lists entry NAMES, not full paths', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const root = fs.rootFor('https://app.example')
    await fs.writeFile(join(root, 'one.txt'), new Uint8Array([1]))
    await fs.writeFile(join(root, 'two.txt'), new Uint8Array([2]))
    await fs.mkdir(join(root, 'sub'))

    const entries = await fs.readdir(root)

    expect([...entries].sort()).toEqual(['one.txt', 'sub', 'two.txt'])
  })

  it('readdir of a missing directory surfaces the raw errno', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)

    await expect(fs.readdir(join(userData, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stat reports size, isFile, isDirectory and mtimeMs for a file', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const path = join(fs.rootFor('https://app.example'), 'f.bin')
    await fs.writeFile(path, new Uint8Array([1, 2, 3, 4]))

    const stat = await fs.stat(path)

    expect(stat.size).toBe(4)
    expect(stat.isFile).toBe(true)
    expect(stat.isDirectory).toBe(false)
    expect(stat.mtimeMs).toBeGreaterThan(0)
  })

  it('stat reports isDirectory for a directory', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const root = fs.rootFor('https://app.example')

    const stat = await fs.stat(root)

    expect(stat.isDirectory).toBe(true)
    expect(stat.isFile).toBe(false)
  })

  it('rm deletes a file', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const path = join(fs.rootFor('https://app.example'), 'gone.txt')
    await fs.writeFile(path, new Uint8Array([1]))

    await fs.rm(path)

    expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined()
  })

  it('rm of a missing path surfaces the raw errno, not a silent success (no `force`)', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)

    await expect(fs.rm(join(userData, 'missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rm recursive:true deletes a whole tree', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const root = fs.rootFor('https://app.example')
    await fs.writeFile(join(root, 'dir', 'nested', 'leaf.txt'), new Uint8Array([1]))

    await fs.rm(join(root, 'dir'), { recursive: true })

    expect(statSync(join(root, 'dir'), { throwIfNoEntry: false })).toBeUndefined()
  })

  it('rm WITHOUT recursive fails on a non-empty directory rather than silently deleting it', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const root = fs.rootFor('https://app.example')
    await fs.writeFile(join(root, 'dir', 'leaf.txt'), new Uint8Array([1]))

    await expect(fs.rm(join(root, 'dir'))).rejects.toBeTruthy()
    expect(statSync(join(root, 'dir')).isDirectory()).toBe(true)
  })

  it('rename moves a file to a new name in the same directory', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const root = fs.rootFor('https://app.example')
    const from = join(root, 'old.txt')
    const to = join(root, 'new.txt')
    await fs.writeFile(from, new Uint8Array([7]))

    await fs.rename(from, to)

    expect(statSync(from, { throwIfNoEntry: false })).toBeUndefined()
    expect(Array.from(await fs.readFile(to))).toEqual([7])
  })

  it('rename does not create the destination\'s parent directory', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const root = fs.rootFor('https://app.example')
    const from = join(root, 'old.txt')
    await fs.writeFile(from, new Uint8Array([7]))

    await expect(fs.rename(from, join(root, 'no-such-dir', 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('readFile never hands back a window into shared memory', () => {
  // Structured clone -- the path this value takes to a renderer -- serialises
  // an ArrayBufferView by serialising its WHOLE backing ArrayBuffer. If the
  // returned view were a slice of Node's shared allocation pool, the page
  // would receive the entire slab and could read the rest of it back as
  // `new Uint8Array(result.buffer)`: bytes it never asked for, from whatever
  // the pool last held.
  it('the returned array owns its buffer exactly (no pooled slack, no offset)', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const path = join(fs.rootFor('https://app.example'), 'small.bin')
    // Small enough to be pool-allocated by Buffer.allocUnsafe, which is what
    // readFileSync and friends use at this size.
    await fs.writeFile(path, new Uint8Array([1, 2, 3, 4, 5]))

    const result = await fs.readFile(path)

    expect(result.byteLength).toBe(5)
    expect(result.byteOffset).toBe(0)
    expect(result.buffer.byteLength).toBe(5)
    // The same property sync-fs-policy.test.ts pins for the synchronous
    // sibling of this call -- a view that owns its buffer exactly, stated
    // as one invariant rather than three coincidentally-equal numbers.
    expect(result.buffer.byteLength).toBe(result.byteLength)
  })

  it('round-trips the actual bytes', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const fs = nodeFs(userData)
    const path = join(fs.rootFor('https://app.example'), 'bytes.bin')
    const written = new Uint8Array([9, 8, 7, 6])
    await fs.writeFile(path, written)

    expect(Array.from(await fs.readFile(path))).toEqual([9, 8, 7, 6])
  })
})

describe('the fs capability works end to end for an origin that has never written before', () => {
  // confinePath's first act is realpath(root), and it denies when that
  // throws -- so a root nothing ever creates denies every path an app asks
  // for, with the same message a real traversal attempt gets. It fails
  // closed, which is why nothing caught it, and it fails always.
  it('rootFor creates the directory it names', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))

    const root = nodeFs(userData).rootFor('https://app.example')

    expect(statSync(root).isDirectory()).toBe(true)
  })

  it("a brand-new origin's very first writeFile succeeds rather than being denied", async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-'))
    const broker = createBroker({
      dial: async () => { throw new Error('not used by this test') },
      dialSecure: async () => { throw new Error('not used by this test') },
      bind: async () => { throw new Error('not used by this test') },
      listen: async () => { throw new Error('not used by this test') },
      resolve: async () => [],
      resolveLookup: async () => [],
      proxyConfigured: async () => false,
      now: () => Date.now(),
      fs: nodeFs(userData),
      keychain: { getSeed: async () => { throw new Error('not used by this test') } },
      pickPath: async () => { throw new Error('not used by this test') }
    })
    broker.registerApp('https://app.example', {
      name: 'probe', version: '1.0.0', orivonApiVersion: 0, capabilities: { fs: { quotaBytes: 1_000_000 } }
    } as never)
    broker.grant('https://app.example', 'fs', [])

    await broker.fs.writeFile('https://app.example', 'hello.txt', new Uint8Array([1, 2, 3]))

    expect(Array.from(await broker.fs.readFile('https://app.example', 'hello.txt'))).toEqual([1, 2, 3])
  })
})

describe('nodeFs.diskUsage', () => {
  it('sums every regular file under a directory, and counts a symlink as itself, never its target', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-du-'))
    const fs = nodeFs(userData)
    const root = fs.rootFor('https://app.example')
    await fs.writeFile(join(root, 'a.bin'), new Uint8Array(10))
    await fs.mkdir(join(root, 'dir', 'deep'), { recursive: true })
    await fs.writeFile(join(root, 'dir', 'deep', 'b.bin'), new Uint8Array(5))
    const outside = join(userData, 'outside.bin')
    await writeFile(outside, new Uint8Array(1_000))
    await symlink(outside, join(root, 'dir', 'link'))

    expect(await fs.diskUsage?.(root)).toBe(15)
    expect(await fs.diskUsage?.(join(root, 'dir'))).toBe(5)
    expect(await fs.diskUsage?.(join(root, 'missing'))).toBe(0)
  })
})

// T13b: an app's own files now live under `app-data/<hash>/files`,
// SEPARATE from the loader's own `apps/<hash>` state (pinned code,
// staging, pin.json) -- `rootFor` moves whatever an earlier version of
// this adapter wrote under the old, shared `apps/<hash>/files` layout the
// first time an origin's `fs` is touched this process.
describe('nodeFs.rootFor -- the one-time move off the old apps/<hash>/files layout', () => {
  const ORIGIN = 'https://app.example'

  it('moves an existing apps/<hash>/files directory to app-data/<hash>/files, keeping every file', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-migrate-'))
    const oldRoot = join(userData, 'apps', originHash(ORIGIN), 'files')
    mkdirSync(join(oldRoot, 'sub'), { recursive: true })
    writeFileSync(join(oldRoot, 'a.bin'), new Uint8Array([1, 2, 3]))
    writeFileSync(join(oldRoot, 'sub', 'b.bin'), new Uint8Array([4, 5]))

    const fs = nodeFs(userData)
    const newRoot = fs.rootFor(ORIGIN)

    expect(newRoot).toBe(join(appDataRoot(userData, ORIGIN), 'files'))
    expect(existsSync(oldRoot)).toBe(false) // moved, not copied
    expect(Array.from(await fsReadFile(join(newRoot, 'a.bin')))).toEqual([1, 2, 3])
    expect(Array.from(await fsReadFile(join(newRoot, 'sub', 'b.bin')))).toEqual([4, 5])
  })

  it('an origin with nothing under the old layout just gets a fresh new-layout root, same as any other first use', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-migrate-'))
    const fs = nodeFs(userData)

    const root = fs.rootFor(ORIGIN)

    expect(root).toBe(join(appDataRoot(userData, ORIGIN), 'files'))
    expect(existsSync(root)).toBe(true)
  })

  it('runs at most once per origin -- a second rootFor call does not touch an already-migrated, already-populated directory', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-migrate-'))
    const oldRoot = join(userData, 'apps', originHash(ORIGIN), 'files')
    mkdirSync(oldRoot, { recursive: true })
    writeFileSync(join(oldRoot, 'a.bin'), new Uint8Array([1]))
    const fs = nodeFs(userData)

    const first = fs.rootFor(ORIGIN)
    writeFileSync(join(first, 'b.bin'), new Uint8Array([2])) // written AFTER the migration
    const second = fs.rootFor(ORIGIN)

    expect(second).toBe(first)
    expect(Array.from(await fsReadFile(join(second, 'a.bin')))).toEqual([1]) // the migrated file
    expect(Array.from(await fsReadFile(join(second, 'b.bin')))).toEqual([2]) // survived the second call
  })

  it('does not re-run the migration check on a later call, even when a fresh old-layout directory reappears', async () => {
    // `vi.spyOn` cannot wrap `node:fs`'s own `existsSync`/`renameSync`
    // (Vitest refuses to redefine a Node built-in's ESM export), so "at
    // most once" is proven the same way NEVER-LOSES-DATA below is: by a
    // directory the SECOND call must leave alone if, and only if,
    // `migrateFilesRoot` did not run again for this origin.
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-migrate-'))
    const fs = nodeFs(userData)
    fs.rootFor(ORIGIN) // nothing to migrate yet; marks ORIGIN as done

    // A directory reappears at the OLD layout's path after the first call --
    // unrealistic in production, but exactly what a re-run of
    // migrateFilesRoot on this second rootFor() would notice and act on.
    const oldRoot = join(userData, 'apps', originHash(ORIGIN), 'files')
    mkdirSync(oldRoot, { recursive: true })
    writeFileSync(join(oldRoot, 'reappeared.bin'), new Uint8Array([7]))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    fs.rootFor(ORIGIN)

    // A second run would have found both roots existing and logged the
    // conflict (see the NEVER-LOSES-DATA case below); skipping the check
    // entirely for an already-done origin means neither happens.
    expect(logged).not.toHaveBeenCalled()
    expect(existsSync(join(oldRoot, 'reappeared.bin'))).toBe(true) // left exactly where it reappeared
    logged.mockRestore()
  })

  it('NEVER LOSES DATA: when both the old and new roots already exist, leaves both alone and logs rather than picking a side', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-migrate-'))
    const oldRoot = join(userData, 'apps', originHash(ORIGIN), 'files')
    const newRoot = join(appDataRoot(userData, ORIGIN), 'files')
    mkdirSync(oldRoot, { recursive: true })
    writeFileSync(join(oldRoot, 'old.bin'), new Uint8Array([9]))
    mkdirSync(newRoot, { recursive: true })
    writeFileSync(join(newRoot, 'new.bin'), new Uint8Array([8]))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const fs = nodeFs(userData)
    const root = fs.rootFor(ORIGIN)

    expect(root).toBe(newRoot)
    expect(existsSync(oldRoot)).toBe(true) // left in place, never deleted
    expect(existsSync(join(oldRoot, 'old.bin'))).toBe(true)
    expect(existsSync(join(newRoot, 'new.bin'))).toBe(true)
    expect(logged).toHaveBeenCalledTimes(1)

    fs.rootFor(ORIGIN) // same still-conflicted origin, again
    expect(logged).toHaveBeenCalledTimes(1) // not once per call -- once per origin, ever

    logged.mockRestore()
  })
})
