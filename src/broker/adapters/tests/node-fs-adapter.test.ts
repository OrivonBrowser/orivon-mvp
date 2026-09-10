import { statSync } from 'node:fs'
import { mkdtemp, readFile as fsReadFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBroker } from '../../index.js'
import { nodeFs } from '../node-fs-adapter.js'
import { originHash } from '../../grants/origin-hash.js'

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
  // fs-capability.ts's mapIoError is the single place an errno becomes an
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
  // fs-capability.ts's job (confinePath, before any of these ever run) --
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
      now: () => Date.now(),
      fs: nodeFs(userData),
      keychain: { getSeed: async () => { throw new Error('not used by this test') } }
    })
    broker.registerApp('https://app.example', {
      name: 'probe', version: '1.0.0', orivonApiVersion: 0, capabilities: { fs: { quotaBytes: 1_000_000 } }
    } as never)
    broker.grant('https://app.example', 'fs', [])

    await broker.fs.writeFile('https://app.example', 'hello.txt', new Uint8Array([1, 2, 3]))

    expect(Array.from(await broker.fs.readFile('https://app.example', 'hello.txt'))).toEqual([1, 2, 3])
  })
})
