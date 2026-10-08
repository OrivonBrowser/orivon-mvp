import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBroker } from '../index.js'
import { nodeFs } from '../adapters/node-adapters.js'
import { isOrivonErrorLike } from '../errors.js'
import { rejection } from '../handles/tests/handles.test-helpers.js'
import { APP, baseDeps, manifestWith, stubFs } from './index.test-helpers.js'
import type { Broker } from '../broker-contracts.js'

// The page's synchronous path-based calls (Broker.fs.sync) share the async
// calls' grant check, confinement and per-origin storage ledger. Run against
// the real node adapter on a temp directory: the blocking twins are the
// subject, so a stub filesystem would test the stub.

const bytes = (n: number): Uint8Array => new Uint8Array(n)

async function realBroker (quotaBytes?: number): Promise<{ broker: Broker, root: string }> {
  const userData = await mkdtemp(join(tmpdir(), 'orivon-fs-sync-'))
  const fs = nodeFs(userData)
  const broker = createBroker(baseDeps({ fs }))
  await broker.registerApp(APP, manifestWith({ fs: quotaBytes === undefined ? {} : { quotaBytes } }))
  await broker.grant(APP, 'fs', [])
  return { broker, root: fs.rootFor(APP) }
}

function thrown (run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

describe('fs.sync: the same grant and confinement as the async calls', () => {
  it('refuses every call as denied without an fs grant', async () => {
    const broker = createBroker(baseDeps({ fs: nodeFs(await mkdtemp(join(tmpdir(), 'orivon-fs-sync-'))) }))
    await broker.registerApp(APP, manifestWith({ fs: {} }))
    const sync = broker.fs.sync
    for (const run of [
      () => sync.writeFile(APP, 'a', bytes(1)), () => { sync.mkdir(APP, 'd') }, () => sync.readdir(APP, '.'),
      () => sync.stat(APP, 'a'), () => { sync.rm(APP, 'a') }, () => { sync.rename(APP, 'a', 'b') }
    ]) {
      const error = thrown(run)
      expect(isOrivonErrorLike(error) && error.code === 'denied').toBe(true)
    }
  })

  it('refuses a path outside the root, and a rename whose destination is outside it, as denied', async () => {
    const { broker } = await realBroker()
    await broker.fs.writeFile(APP, 'a', bytes(1))
    for (const run of [
      () => broker.fs.sync.writeFile(APP, '../escape', bytes(1)),
      () => { broker.fs.sync.mkdir(APP, '../../escape', { recursive: true }) },
      () => broker.fs.sync.stat(APP, '../../etc/passwd'),
      () => { broker.fs.sync.rm(APP, '../escape') },
      () => { broker.fs.sync.rename(APP, 'a', '../../escape') }
    ]) {
      const error = thrown(run)
      expect(isOrivonErrorLike(error) && error.code === 'denied').toBe(true)
    }
  })

  it('fails unavailable where the injected filesystem has no blocking twins', async () => {
    const broker = createBroker(baseDeps({ fs: stubFs() }))
    await broker.registerApp(APP, manifestWith({ fs: {} }))
    await broker.grant(APP, 'fs', [])
    const error = thrown(() => { broker.fs.sync.mkdir(APP, 'd') })
    expect(isOrivonErrorLike(error) && error.code === 'unavailable').toBe(true)
  })
})

describe('fs.sync: what lands is what the async calls see', () => {
  it('mkdir recursive, writeFile (which creates parents), stat, readdir, rename and rm round-trip with the async reads', async () => {
    const { broker } = await realBroker()
    broker.fs.sync.mkdir(APP, 'a/b', { recursive: true })
    broker.fs.sync.writeFile(APP, 'a/b/f.txt', new Uint8Array([1, 2, 3]))
    broker.fs.sync.writeFile(APP, 'c/d/g.txt', new Uint8Array([9]))

    expect(Array.from(await broker.fs.readFile(APP, 'a/b/f.txt'))).toEqual([1, 2, 3])
    expect(Array.from(await broker.fs.readFile(APP, 'c/d/g.txt'))).toEqual([9])
    expect(broker.fs.sync.stat(APP, 'a/b/f.txt')).toMatchObject({ size: 3, isFile: true, isDirectory: false })
    expect(broker.fs.sync.readdir(APP, 'a/b')).toEqual(['f.txt'])
    expect(await broker.fs.readdir(APP, 'a/b')).toEqual(['f.txt'])

    broker.fs.sync.rename(APP, 'a/b/f.txt', 'a/b/h.txt')
    expect(await broker.fs.readdir(APP, 'a/b')).toEqual(['h.txt'])
    broker.fs.sync.rm(APP, 'a', { recursive: true })
    expect((await rejection(broker.fs.stat(APP, 'a'))).code).toBe('notFound')
  })

  it('surfaces the raw Node error for the caller to map: ENOENT, EEXIST, ENOTDIR', async () => {
    const { broker } = await realBroker()
    broker.fs.sync.mkdir(APP, 'd')
    broker.fs.sync.writeFile(APP, 'file', bytes(1))
    expect(thrown(() => broker.fs.sync.stat(APP, 'missing'))).toMatchObject({ code: 'ENOENT' })
    expect(thrown(() => { broker.fs.sync.mkdir(APP, 'd') })).toMatchObject({ code: 'EEXIST' })
    expect(thrown(() => broker.fs.sync.readdir(APP, 'file'))).toMatchObject({ code: 'ENOTDIR' })
    expect(thrown(() => { broker.fs.sync.mkdir(APP, 'x/y') })).toMatchObject({ code: 'ENOENT' })
  })
})

describe('fs.sync: the storage quota is enforced on the same ledger as the async calls', () => {
  it('refuses a write past the quota as limit, and nothing lands', async () => {
    const { broker } = await realBroker(100)
    broker.fs.sync.writeFile(APP, 'a', bytes(60))

    const error = thrown(() => broker.fs.sync.writeFile(APP, 'b', bytes(60)))
    expect(isOrivonErrorLike(error) && error.code === 'limit').toBe(true)
    expect((await rejection(broker.fs.stat(APP, 'b'))).code).toBe('notFound')
  })

  it('shares the count with the async calls in both directions', async () => {
    const { broker } = await realBroker(100)
    await broker.fs.writeFile(APP, 'async', bytes(60))
    expect(isOrivonErrorLike(thrown(() => broker.fs.sync.writeFile(APP, 'sync', bytes(60))))).toBe(true)

    broker.fs.sync.writeFile(APP, 'sync', bytes(40))
    expect((await rejection(broker.fs.writeFile(APP, 'more', bytes(1)))).code).toBe('limit')
  })

  it('counts what is already on disk, measured on the first synchronous write', async () => {
    const { broker, root } = await realBroker(100)
    await mkdir(join(root, 'old'), { recursive: true })
    await writeFile(join(root, 'old', 'big.bin'), bytes(90))

    expect(isOrivonErrorLike(thrown(() => broker.fs.sync.writeFile(APP, 'new', bytes(20))))).toBe(true)
    broker.fs.sync.writeFile(APP, 'new', bytes(10))
    // Measured once: a second write is not charged the old bytes again.
    expect(isOrivonErrorLike(thrown(() => broker.fs.sync.writeFile(APP, 'new2', bytes(1))))).toBe(true)
  })

  it('an async measurement still in flight is not charged on top of a synchronous one', async () => {
    const { broker, root } = await realBroker(100)
    await writeFile(join(root, 'old.bin'), bytes(50))

    const pending = broker.fs.writeFile(APP, 'first', bytes(10)) // starts the async measurement
    broker.fs.sync.writeFile(APP, 'second', bytes(10)) // measures synchronously before it finishes
    await pending

    // 50 + 10 + 10 = 70 used: 30 left, and not 20 as a double count would leave.
    await expect(broker.fs.writeFile(APP, 'third', bytes(30))).resolves.toBeUndefined()
    expect((await rejection(broker.fs.writeFile(APP, 'fourth', bytes(1)))).code).toBe('limit')
  })

  it('an overwrite charges only its growth and a smaller one gives the difference back', async () => {
    const { broker } = await realBroker(100)
    broker.fs.sync.writeFile(APP, 'a', bytes(90))
    broker.fs.sync.writeFile(APP, 'a', bytes(95))
    broker.fs.sync.writeFile(APP, 'a', bytes(10))
    broker.fs.sync.writeFile(APP, 'b', bytes(80))
  })

  it('rm gives back a file and a whole directory', async () => {
    const { broker } = await realBroker(100)
    broker.fs.sync.writeFile(APP, 'a', bytes(90))
    broker.fs.sync.rm(APP, 'a')
    broker.fs.sync.writeFile(APP, 'cache/one', bytes(45))
    broker.fs.sync.writeFile(APP, 'cache/two', bytes(45))
    broker.fs.sync.rm(APP, 'cache', { recursive: true })
    broker.fs.sync.writeFile(APP, 'b', bytes(90))
  })

  it('rename over a file gives the replaced file back, and onto itself gives nothing back', async () => {
    const { broker } = await realBroker(100)
    broker.fs.sync.writeFile(APP, 'data.db', bytes(60))
    broker.fs.sync.writeFile(APP, 'data.db~', bytes(30))
    broker.fs.sync.rename(APP, 'data.db~', 'data.db')
    broker.fs.sync.writeFile(APP, 'more', bytes(70))

    broker.fs.sync.rename(APP, 'more', 'more')
    expect(isOrivonErrorLike(thrown(() => broker.fs.sync.writeFile(APP, 'x', bytes(31))))).toBe(true)
  })

  it('a write that fails on disk gives its reservation back', async () => {
    const { broker } = await realBroker(100)
    broker.fs.sync.mkdir(APP, 'dir')
    expect(thrown(() => broker.fs.sync.writeFile(APP, 'dir', bytes(90)))).toMatchObject({ code: 'EISDIR' })
    broker.fs.sync.writeFile(APP, 'ok', bytes(100))
  })

  it('an undeclared quota is unlimited', async () => {
    const { broker } = await realBroker()
    broker.fs.sync.writeFile(APP, 'a', bytes(100_000))
  })
})
