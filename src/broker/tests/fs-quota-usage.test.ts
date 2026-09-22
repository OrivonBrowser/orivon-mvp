import { describe, expect, it } from 'vitest'
import { rejection } from '../handles/tests/handles.test-helpers.js'
import { APP, baseDeps, manifestWith, stubFs } from './index.test-helpers.js'
import { createBroker } from '../index.js'
import type { Broker } from '../broker-contracts.js'

// fs.quotaBytes measures what the app's files occupy, not how many bytes it
// has ever written: rewriting a file charges only its growth, removing or
// replacing one gives its bytes back, and the count starts from what is
// already on disk rather than from zero every session.

const ROOT = '/apps/app'

async function quotaBroker (quotaBytes: number, files = new Map<string, Uint8Array>()): Promise<Broker> {
  const broker = createBroker(baseDeps({ fs: stubFs({ files }) }))
  await broker.registerApp(APP, manifestWith({ fs: { quotaBytes } }))
  await broker.grant(APP, 'fs', [])
  return broker
}

const bytes = (n: number): Uint8Array => new Uint8Array(n)

describe('fs.quotaBytes counts disk usage', () => {
  it('rewriting a file charges only its growth -- a database rewritten on every load never runs out', async () => {
    const broker = await quotaBroker(100)

    for (let i = 0; i < 10; i += 1) await broker.fs.writeFile(APP, 'data.db', bytes(80))
    await broker.fs.writeFile(APP, 'data.db', bytes(90))

    expect((await rejection(broker.fs.writeFile(APP, 'other.db', bytes(20)))).code).toBe('limit')
  })

  it('rewriting a file smaller gives the difference back', async () => {
    const broker = await quotaBroker(100)
    await broker.fs.writeFile(APP, 'a', bytes(90))

    await broker.fs.writeFile(APP, 'a', bytes(10))

    await expect(broker.fs.writeFile(APP, 'b', bytes(80))).resolves.toBeUndefined()
  })

  it('removing a file gives its bytes back', async () => {
    const broker = await quotaBroker(100)
    await broker.fs.writeFile(APP, 'a', bytes(90))

    await broker.fs.rm(APP, 'a')

    await expect(broker.fs.writeFile(APP, 'b', bytes(90))).resolves.toBeUndefined()
  })

  it('removing a directory gives back everything under it', async () => {
    const broker = await quotaBroker(100)
    await broker.fs.mkdir(APP, 'cache', { recursive: true })
    await broker.fs.writeFile(APP, 'cache/one', bytes(45))
    await broker.fs.writeFile(APP, 'cache/two', bytes(45))

    await broker.fs.rm(APP, 'cache', { recursive: true })

    await expect(broker.fs.writeFile(APP, 'b', bytes(90))).resolves.toBeUndefined()
  })

  it('renaming over a file gives the replaced file\'s bytes back -- the write-then-rename save', async () => {
    const broker = await quotaBroker(100)
    await broker.fs.writeFile(APP, 'data.db', bytes(60))
    await broker.fs.writeFile(APP, 'data.db~', bytes(30))

    await broker.fs.rename(APP, 'data.db~', 'data.db')

    await expect(broker.fs.writeFile(APP, 'more', bytes(70))).resolves.toBeUndefined()
  })

  it('renaming a file onto itself gives nothing back', async () => {
    const broker = await quotaBroker(100)
    await broker.fs.writeFile(APP, 'a', bytes(90))

    await broker.fs.rename(APP, 'a', 'a')

    expect((await rejection(broker.fs.writeFile(APP, 'b', bytes(20)))).code).toBe('limit')
  })

  it('starts from what is already on disk, not from zero', async () => {
    const broker = await quotaBroker(100, new Map([[`${ROOT}/old.db`, bytes(90)]]))

    expect((await rejection(broker.fs.writeFile(APP, 'new.db', bytes(20)))).code).toBe('limit')
    await expect(broker.fs.writeFile(APP, 'new.db', bytes(10))).resolves.toBeUndefined()
  })
})
