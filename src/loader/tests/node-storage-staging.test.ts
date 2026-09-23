import { mkdtemp, readdir, readFile, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeLoaderStorage } from '../node-storage.js'
import { appRootDirectoryName } from '../storage.js'
import { ORIGIN, utf8 } from './test-helpers.js'

async function freshStorage (): Promise<{ storage: ReturnType<typeof nodeLoaderStorage>, appDir: string }> {
  const userData = await mkdtemp(join(tmpdir(), 'orivon-staging-'))
  return { storage: nodeLoaderStorage(userData), appDir: join(userData, 'apps', appRootDirectoryName(ORIGIN)) }
}

async function collect (chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = []
  for await (const chunk of chunks) parts.push(chunk)
  return Buffer.concat(parts).toString('utf8')
}

describe('nodeLoaderStorage staging', () => {
  it('a staged file is invisible to readAsset until committed, then replaces the asset in place', async () => {
    const { storage } = await freshStorage()
    await storage.writeAsset(ORIGIN, '/app.js', utf8('old'))

    const writer = await storage.openStaged(ORIGIN)
    await writer.write(utf8('ne'))
    await writer.write(utf8('w'))
    await writer.close()
    expect(new TextDecoder().decode(await storage.readAsset(ORIGIN, '/app.js'))).toBe('old')

    const staged = await storage.readStaged(ORIGIN, writer.id)
    expect(staged?.byteLength).toBe(3)
    expect(await collect(staged!.chunks)).toBe('new')

    await storage.commitStaged(ORIGIN, writer.id, '/app.js')
    expect(new TextDecoder().decode(await storage.readAsset(ORIGIN, '/app.js'))).toBe('new')
    expect(await storage.readStaged(ORIGIN, writer.id)).toBeUndefined()
  })

  it('staging lives beside code/, never inside it, and clearStaging empties it', async () => {
    const { storage, appDir } = await freshStorage()
    const writer = await storage.openStaged(ORIGIN)
    await writer.close()

    expect(await readdir(join(appDir, 'staging'))).toEqual([writer.id])
    await storage.clearStaging(ORIGIN)
    await expect(readdir(join(appDir, 'staging'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await storage.readStaged(ORIGIN, writer.id)).toBeUndefined()
  })

  it('refuses a staged id it did not issue rather than joining it into a path', async () => {
    const { storage } = await freshStorage()
    expect(await storage.readStaged(ORIGIN, '../pin.json')).toBeUndefined()
    await expect(storage.commitStaged(ORIGIN, '../pin.json', '/x.js')).rejects.toThrow()
  })

  it('refuses a staging directory that is a symlink', async () => {
    const { storage, appDir } = await freshStorage()
    await mkdir(appDir, { recursive: true })
    const elsewhere = await mkdtemp(join(tmpdir(), 'orivon-staging-target-'))
    await symlink(elsewhere, join(appDir, 'staging'))

    await expect(storage.openStaged(ORIGIN)).rejects.toThrow(/not a directory Orivon created/)
    await expect(storage.clearStaging(ORIGIN)).rejects.toThrow(/not a directory Orivon created/)
  })

  it('writes the pin and a written asset without leaving a temporary file behind', async () => {
    const { storage, appDir } = await freshStorage()
    await storage.writeAsset(ORIGIN, '/index.html', utf8('<h1>hi</h1>'))
    await storage.writePin(ORIGIN, { schema: 1, origin: ORIGIN, bundleHash: 'sha256:' + 'a'.repeat(64), assets: [], version: '1.0.0', pinnedAt: 0 } as never)

    expect(JSON.parse(await readFile(join(appDir, 'pin.json'), 'utf8'))).toMatchObject({ origin: ORIGIN })
    expect(await readdir(join(appDir, 'staging'))).toEqual([])
  })

  it('readAssetStream reports the size and streams the bytes of a written asset, and undefined for a missing one', async () => {
    const { storage } = await freshStorage()
    await storage.writeAsset(ORIGIN, '/data.bin', utf8('0123456789'))

    const stream = await storage.readAssetStream(ORIGIN, '/data.bin')
    expect(stream?.byteLength).toBe(10)
    expect(await collect(stream!.chunks)).toBe('0123456789')
    expect(await storage.readAssetStream(ORIGIN, '/missing.bin')).toBeUndefined()
  })
})
