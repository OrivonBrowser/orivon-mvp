import { describe, expect, it } from 'vitest'
import { rejection } from '../handles/tests/handles.test-helpers.js'
import { APP, baseDeps, manifestWith, stubFs } from './index.test-helpers.js'
import { createBroker } from '../index.js'
import type { Broker } from '../broker-contracts.js'

// orivon.fs's extended surface (queue item 2.1): mkdir, readdir, stat, rm,
// rename. Its own file rather than more of index.test.ts, matching
// index-listen.test.ts/index-udp.test.ts's own precedent for a capability
// that outgrew the original suite.
//
// THE POINT OF THIS FILE, restated from the queue item's own exit
// criterion: confinement is proven PER CALL, not assumed from readFile's
// coverage. Every describe block below that exercises a NEW entry point
// includes its own traversal-denial test, run against the exact
// createFsCapability() code path (via createBroker), not a copy of
// paths.test.ts's own confinePath suite -- what could be wrong here is the
// WIRING (an entry point that forgets to call confineForOrigin, or calls it
// on only one of rename's two paths), not confinePath itself.

/** A broker with `fs` granted (no patterns -- FsCapability carries none) and a working in-memory root. */
async function fsBroker (files = new Map<string, Uint8Array>()): Promise<Broker> {
  const broker = createBroker(baseDeps({ fs: stubFs({ files }) }))
  broker.registerApp(APP, manifestWith({ fs: {} }))
  await broker.grant(APP, 'fs', [])
  return broker
}

describe('fs.mkdir', () => {
  it('denies when fs was never granted', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({}))

    const error = await rejection(broker.fs.mkdir(APP, 'a'))
    expect(error.code).toBe('denied')
  })

  it('denies a traversal attempt outside the app root, with no platformCode', async () => {
    const broker = await fsBroker()

    const error = await rejection(broker.fs.mkdir(APP, '../../etc/orivon-evil'))
    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
  })

  it('creates a directory inside the app root, visible to readdir', async () => {
    // Not readdir('.') -- confinePath rejects the app's own root as
    // 'is-root' for every fs call, an existing, tested rule
    // (policy/tests/paths.test.ts), not something this lane changes.
    const broker = await fsBroker()
    await broker.fs.mkdir(APP, 'parent')

    await broker.fs.mkdir(APP, 'parent/sub')

    await expect(broker.fs.readdir(APP, 'parent')).resolves.toContain('sub')
  })

  it('recursive:true creates missing parents; without it a missing parent is notFound', async () => {
    const broker = await fsBroker()

    await expect(broker.fs.mkdir(APP, 'a/b/c')).rejects.toMatchObject({ code: 'notFound' })
    await broker.fs.mkdir(APP, 'a/b/c', { recursive: true })
    await expect(broker.fs.readdir(APP, 'a/b')).resolves.toContain('c')
  })

  it('revoking the fs grant denies a subsequent mkdir', async () => {
    const broker = createBroker(baseDeps({ fs: stubFs() }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    const g = await broker.grant(APP, 'fs', [])
    await broker.revoke(APP, g.id)

    const error = await rejection(broker.fs.mkdir(APP, 'a'))
    expect(error.code).toBe('denied')
  })
})

describe('fs.readdir', () => {
  it('denies when fs was never granted', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({}))

    const error = await rejection(broker.fs.readdir(APP, '.'))
    expect(error.code).toBe('denied')
  })

  it('denies a traversal attempt outside the app root, with no platformCode', async () => {
    const broker = await fsBroker()

    const error = await rejection(broker.fs.readdir(APP, '../../etc'))
    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
  })

  it('lists entry names, confined to the app root, never full paths', async () => {
    // Not readdir('.') -- see fs.mkdir's own note above on 'is-root'.
    const files = new Map<string, Uint8Array>([['/apps/app/dir/one.txt', new Uint8Array([1])]])
    const broker = await fsBroker(files)
    await broker.fs.mkdir(APP, 'dir/sub', { recursive: true })

    const entries = await broker.fs.readdir(APP, 'dir')

    expect([...entries].sort()).toEqual(['one.txt', 'sub'])
  })

  it('maps a missing directory to notFound, never forwarding the confined path', async () => {
    const broker = await fsBroker()

    const error = await rejection(broker.fs.readdir(APP, 'missing-dir'))
    expect(error.code).toBe('notFound')
    expect(error.message).not.toContain('/apps/app')
  })
})

describe('fs.stat', () => {
  it('denies when fs was never granted', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({}))

    const error = await rejection(broker.fs.stat(APP, 'a.txt'))
    expect(error.code).toBe('denied')
  })

  it('denies a traversal attempt outside the app root, with no platformCode', async () => {
    const broker = await fsBroker()

    const error = await rejection(broker.fs.stat(APP, '../../etc/passwd'))
    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
  })

  it('reports size/isFile/isDirectory for a file and a directory', async () => {
    const broker = await fsBroker()
    await broker.fs.writeFile(APP, 'f.bin', new Uint8Array([1, 2, 3]))
    await broker.fs.mkdir(APP, 'sub')

    const fileStat = await broker.fs.stat(APP, 'f.bin')
    expect(fileStat).toMatchObject({ size: 3, isFile: true, isDirectory: false })

    const dirStat = await broker.fs.stat(APP, 'sub')
    expect(dirStat).toMatchObject({ isFile: false, isDirectory: true })
  })

  it('maps a missing path to notFound', async () => {
    const broker = await fsBroker()

    const error = await rejection(broker.fs.stat(APP, 'missing.txt'))
    expect(error.code).toBe('notFound')
  })
})

describe('fs.rm', () => {
  it('denies when fs was never granted', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({}))

    const error = await rejection(broker.fs.rm(APP, 'a.txt'))
    expect(error.code).toBe('denied')
  })

  it('denies a traversal attempt outside the app root, with no platformCode -- deletion, not just a leak', async () => {
    const broker = await fsBroker()

    const error = await rejection(broker.fs.rm(APP, '../../etc/passwd'))
    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
  })

  it('deletes a file inside the app root', async () => {
    const broker = await fsBroker()
    await broker.fs.writeFile(APP, 'gone.txt', new Uint8Array([1]))

    await broker.fs.rm(APP, 'gone.txt')

    const error = await rejection(broker.fs.readFile(APP, 'gone.txt'))
    expect(error.code).toBe('notFound')
  })

  // The exit criterion's own wording: "a path that escapes confinement here
  // is not a leak, it is destruction". recursive:true is bounded to the
  // CONFINED subtree, never the literal string the app passed -- proven by
  // confining the top-level target exactly like every other call, then
  // deleting only what stubFs's own recursive walk finds under it.
  it('recursive:true deletes a whole tree, confined to the app root', async () => {
    const broker = await fsBroker()
    await broker.fs.writeFile(APP, 'dir/nested/leaf.txt', new Uint8Array([1]))
    await broker.fs.writeFile(APP, 'keep.txt', new Uint8Array([2]))

    await broker.fs.rm(APP, 'dir', { recursive: true })

    await expect(rejection(broker.fs.readFile(APP, 'dir/nested/leaf.txt'))).resolves.toMatchObject({ code: 'notFound' })
    await expect(broker.fs.readFile(APP, 'keep.txt')).resolves.toEqual(new Uint8Array([2]))
  })

  it('without recursive, refuses to delete a non-empty directory rather than silently succeeding', async () => {
    const broker = await fsBroker()
    await broker.fs.writeFile(APP, 'dir/leaf.txt', new Uint8Array([1]))

    await expect(broker.fs.rm(APP, 'dir')).rejects.toBeTruthy()
    await expect(broker.fs.readFile(APP, 'dir/leaf.txt')).resolves.toEqual(new Uint8Array([1]))
  })

  it('a missing path is notFound, never a silent success (no `force` at this layer)', async () => {
    const broker = await fsBroker()

    const error = await rejection(broker.fs.rm(APP, 'missing.txt'))
    expect(error.code).toBe('notFound')
  })
})

describe('fs.rename -- BOTH paths are confined, not only the source', () => {
  it('denies when fs was never granted', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({}))

    const error = await rejection(broker.fs.rename(APP, 'a.txt', 'b.txt'))
    expect(error.code).toBe('denied')
  })

  it('denies a traversal on the SOURCE, with no platformCode', async () => {
    const broker = await fsBroker()

    const error = await rejection(broker.fs.rename(APP, '../../etc/passwd', 'stolen.txt'))
    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
  })

  // THE test the queue item's own exit criterion names by requirement: a
  // confinement check on `from` alone, with `to` unchecked, is how
  // orivon.fs.rename becomes an arbitrary-write primitive -- a legitimate
  // file inside the app's own root, renamed to a path outside it entirely.
  // `from` here is completely ordinary and inside the root; only `to`
  // escapes. If this ever regresses to checking one side only, this is the
  // test that catches it.
  it('rename confines the destination, not only the source', async () => {
    const files = new Map<string, Uint8Array>([['/apps/app/legit.txt', new Uint8Array([9])]])
    const broker = await fsBroker(files)

    const error = await rejection(broker.fs.rename(APP, 'legit.txt', '../../etc/passwd'))

    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
    // Nothing moved: the source file is still exactly where it was, and
    // nothing landed outside the root.
    expect(files.get('/apps/app/legit.txt')).toEqual(new Uint8Array([9]))
    expect(files.has('/etc/passwd')).toBe(false)
  })

  it('renames a file within the app root', async () => {
    const broker = await fsBroker()
    await broker.fs.writeFile(APP, 'old.txt', new Uint8Array([7]))

    await broker.fs.rename(APP, 'old.txt', 'new.txt')

    await expect(rejection(broker.fs.readFile(APP, 'old.txt'))).resolves.toMatchObject({ code: 'notFound' })
    await expect(broker.fs.readFile(APP, 'new.txt')).resolves.toEqual(new Uint8Array([7]))
  })

  it('revoking the fs grant denies a subsequent rename', async () => {
    const broker = createBroker(baseDeps({ fs: stubFs() }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    const g = await broker.grant(APP, 'fs', [])
    await broker.revoke(APP, g.id)

    const error = await rejection(broker.fs.rename(APP, 'a.txt', 'b.txt'))
    expect(error.code).toBe('denied')
  })
})
