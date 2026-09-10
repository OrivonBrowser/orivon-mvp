import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSyncFsPolicy } from '../sync-fs-policy.js'
import { createBroker } from '../../index.js'
import { nodeFs } from '../../adapters/node-adapters.js'
import { isOrivonErrorLike } from '../../errors.js'
import type { Broker, CreateBrokerOptions } from '../../broker-contracts.js'
import type { Manifest } from '../../../contracts/index.js'

// A REAL Broker (createBroker over the real nodeFs adapter, imported
// read-only) -- proving createSyncFsPolicy's production wiring reuses
// ../index.ts's actual Broker.fs.confineSync (ADR-0016), backed by a real
// GrantLedger and real disk confinement, not merely that ./sync-fs.ts's
// pure handler routes correctly to whatever policy it is given.

const APP = 'https://app.example'
const tempDirs: string[] = []

function testManifest (): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'org.orivon.test',
    name: 'Test',
    version: '1.0.0',
    entry: '/index.html',
    capabilities: { fs: { quotaBytes: 1_048_576 } }
  }
}

async function realBroker (): Promise<{ broker: Broker, userData: string }> {
  const userData = await mkdtemp(join(tmpdir(), 'orivon-syncfs-policy-'))
  tempDirs.push(userData)
  const notUsed = async (): Promise<never> => { throw new Error('not exercised by this suite') }
  const deps: CreateBrokerOptions = {
    dial: notUsed,
    dialSecure: notUsed,
    bind: notUsed,
    listen: notUsed,
    resolve: notUsed,
    now: () => Date.now(),
    fs: nodeFs(userData),
    keychain: { getSeed: notUsed }
  }
  return { broker: createBroker(deps), userData }
}

afterEach(() => {
  // Best-effort: leaving a temp dir behind on a failed rm is not this
  // suite's concern, and node-adapters.test.ts's own suite leaves the same
  // cleanup out for the same reason -- CI images are ephemeral.
  tempDirs.length = 0
})

describe('createSyncFsPolicy (real Broker.fs.confineSync)', () => {
  it('denies with no platformCode when the origin holds no fs grant, before any disk access', async () => {
    const { broker } = await realBroker()
    const policy = createSyncFsPolicy(broker)

    let caught: unknown
    try {
      policy.confine(APP, 'a.txt')
    } catch (e) {
      caught = e
    }

    expect(isOrivonErrorLike(caught) && caught.code === 'denied').toBe(true)
    expect(isOrivonErrorLike(caught) ? caught.platformCode : 'not-orivon-error').toBeUndefined()
  })

  it('confines and reads a real file under a real grant', async () => {
    const { broker } = await realBroker()
    await broker.registerApp(APP, testManifest())
    await broker.grant(APP, 'fs', [])
    // Written through the broker's own async fs.writeFile -- the same
    // production path an app actually uses -- so the file this test reads
    // back is exactly what ends up on disk in practice, not a fixture this
    // test staged some other way.
    await broker.fs.writeFile(APP, 'a.txt', new Uint8Array([1, 2, 3]))
    const policy = createSyncFsPolicy(broker)

    const resolved = policy.confine(APP, 'a.txt')
    const bytes = policy.readFileSync(resolved)

    expect(Array.from(bytes)).toEqual([1, 2, 3])
  })

  it('refuses a traversal attempt with \'denied\', identically to a missing grant -- never a distinguishable reason', async () => {
    const { broker } = await realBroker()
    await broker.registerApp(APP, testManifest())
    await broker.grant(APP, 'fs', [])
    const policy = createSyncFsPolicy(broker)

    let caught: unknown
    try {
      policy.confine(APP, '../../../etc/passwd')
    } catch (e) {
      caught = e
    }

    expect(isOrivonErrorLike(caught) && caught.code === 'denied').toBe(true)
    expect(isOrivonErrorLike(caught) ? caught.platformCode : 'not-orivon-error').toBeUndefined()
  })

  it('is refused again once the fs grant is revoked', async () => {
    const { broker } = await realBroker()
    await broker.registerApp(APP, testManifest())
    const record = await broker.grant(APP, 'fs', [])
    const policy = createSyncFsPolicy(broker)
    // Proves the grant is live before revoking, so the assertion below is
    // about revocation specifically, not a grant that never took.
    expect(() => policy.confine(APP, 'a.txt')).not.toThrow()

    await broker.revoke(APP, record.id)

    let caught: unknown
    try {
      policy.confine(APP, 'a.txt')
    } catch (e) {
      caught = e
    }
    expect(isOrivonErrorLike(caught) && caught.code === 'denied').toBe(true)
  })

  it('readFileSync throws a raw Node error for a confined path that does not exist on disk (mapped by the caller, not this file)', async () => {
    const { broker, userData } = await realBroker()
    await broker.registerApp(APP, testManifest())
    await broker.grant(APP, 'fs', [])
    const policy = createSyncFsPolicy(broker)
    // The root must exist for confinePath's own realpath walk to succeed --
    // an app's files directory is created on first write in production;
    // this test only needs the directory, not any file in it.
    await mkdir(nodeFs(userData).rootFor(APP), { recursive: true })

    const resolved = policy.confine(APP, 'missing.txt')

    expect(() => policy.readFileSync(resolved)).toThrow(/ENOENT/)
  })
})
