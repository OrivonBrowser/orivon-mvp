import { mkdtemp, readFile as fsReadFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeLoaderStorage } from './node-storage.js'
import { appRootDirectoryName } from './storage.js'
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
