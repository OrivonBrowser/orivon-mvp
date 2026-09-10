import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSyncFsPolicy } from '../sync-fs-policy.js'
import { nodeFs } from '../../adapters/node-adapters.js'
import { isOrivonErrorLike } from '../../errors.js'

// Real disk, real confinePath, real fs.rootFor/realpathSync (via ../../
// adapters/node-adapters.ts's nodeFs, imported read-only -- this lane may
// not edit that file, only use its exports) -- proving the PRODUCTION
// policy enforces the same confinement ../index.ts's own confineForOrigin
// does, not just that ./sync-fs.ts's pure handler routes correctly to
// whatever policy it is given.

const APP = 'https://app.example'
const tempDirs: string[] = []

async function tempUserData (): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orivon-syncfs-policy-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  // Best-effort: leaving a temp dir behind on a failed rm is not this
  // suite's concern, and node-adapters.test.ts's own suite leaves the same
  // cleanup out for the same reason -- CI images are ephemeral.
  tempDirs.length = 0
})

describe('createSyncFsPolicy', () => {
  it('denies with no platformCode when hasFsGrant reports no grant, before any disk access', async () => {
    const userData = await tempUserData()
    const fs = nodeFs(userData)
    const policy = createSyncFsPolicy({ hasFsGrant: () => false, rootFor: fs.rootFor, realpathSync: fs.realpathSync })

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
    const userData = await tempUserData()
    const fs = nodeFs(userData)
    const root = fs.rootFor(APP)
    const filePath = join(root, 'a.txt')
    await fs.writeFile(filePath, new Uint8Array([1, 2, 3]))
    const policy = createSyncFsPolicy({ hasFsGrant: () => true, rootFor: fs.rootFor, realpathSync: fs.realpathSync })

    const resolved = policy.confine(APP, 'a.txt')
    const bytes = policy.readFileSync(resolved)

    expect(resolved).toBe(filePath)
    expect(Array.from(bytes)).toEqual([1, 2, 3])
  })

  it('refuses a traversal attempt with \'denied\', identically to a missing grant -- never a distinguishable reason', async () => {
    const userData = await tempUserData()
    const fs = nodeFs(userData)
    const policy = createSyncFsPolicy({ hasFsGrant: () => true, rootFor: fs.rootFor, realpathSync: fs.realpathSync })

    let caught: unknown
    try {
      policy.confine(APP, '../../../etc/passwd')
    } catch (e) {
      caught = e
    }

    expect(isOrivonErrorLike(caught) && caught.code === 'denied').toBe(true)
    expect(isOrivonErrorLike(caught) ? caught.platformCode : 'not-orivon-error').toBeUndefined()
  })

  it('readFileSync throws a raw Node error for a confined path that does not exist on disk (mapped by the caller, not this file)', async () => {
    const userData = await tempUserData()
    const fs = nodeFs(userData)
    // The root must exist for confinePath's own realpath walk to succeed --
    // an app's files directory is created on first write in production
    // (node-adapters.ts's own writeFile); this test only needs the
    // directory, not any file in it.
    await mkdir(fs.rootFor(APP), { recursive: true })
    const policy = createSyncFsPolicy({ hasFsGrant: () => true, rootFor: fs.rootFor, realpathSync: fs.realpathSync })

    const resolved = policy.confine(APP, 'missing.txt')

    expect(() => policy.readFileSync(resolved)).toThrow(/ENOENT/)
  })
})
