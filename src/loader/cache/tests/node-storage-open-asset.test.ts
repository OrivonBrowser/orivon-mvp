import { mkdtemp, readFile, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeLoaderStorage } from '../node-storage.js'
import { appRootDirectoryName } from '../storage.js'
import { ORIGIN, utf8 } from '../../tests/test-helpers.js'

async function freshStorage (): Promise<{ storage: ReturnType<typeof nodeLoaderStorage>, codeDir: string }> {
  const userData = await mkdtemp(join(tmpdir(), 'orivon-open-asset-'))
  return { storage: nodeLoaderStorage(userData), codeDir: join(userData, 'apps', appRootDirectoryName(ORIGIN), 'code') }
}

async function collect (chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = []
  for await (const chunk of chunks) parts.push(chunk)
  return parts
}

async function text (chunks: AsyncIterable<Uint8Array>): Promise<string> {
  return Buffer.concat(await collect(chunks)).toString('utf8')
}

describe('nodeLoaderStorage.openAsset', () => {
  it('reports the size and reads any inclusive byte range', async () => {
    const { storage } = await freshStorage()
    await storage.writeAsset(ORIGIN, '/app.js', utf8('0123456789'))
    const asset = await storage.openAsset(ORIGIN, '/app.js')
    expect(asset?.byteLength).toBe(10)
    expect(await text(asset!.read(0, 9))).toBe('0123456789')
    expect(await text(asset!.read(3, 5))).toBe('345')
    expect(await text(asset!.read(0, -1))).toBe('')
    await asset!.close()
    await asset!.close()
  })

  it('reads a large file in bounded chunks, never in one buffer', async () => {
    const { storage } = await freshStorage()
    await storage.writeAsset(ORIGIN, '/big.bin', new Uint8Array(1024 * 1024).fill(7))
    const asset = await storage.openAsset(ORIGIN, '/big.bin')
    const parts = await collect(asset!.read(0, asset!.byteLength - 1))
    await asset!.close()
    expect(parts.length).toBeGreaterThan(1)
    expect(Math.max(...parts.map((part) => part.length))).toBeLessThanOrEqual(64 * 1024)
    expect(parts.reduce((total, part) => total + part.length, 0)).toBe(1024 * 1024)
  })

  it('is undefined for a missing file, a directory, and an unconfinable path', async () => {
    const { storage } = await freshStorage()
    await storage.writeAsset(ORIGIN, '/dir/inner.js', utf8('x'))
    expect(await storage.openAsset(ORIGIN, '/missing.js')).toBeUndefined()
    expect(await storage.openAsset(ORIGIN, '/dir')).toBeUndefined()
    expect(await storage.openAsset(ORIGIN, '/%2E%2E/pin.json')).toBeUndefined()
  })

  it('changes identity when the file is replaced, and keeps reading the bytes it opened', async () => {
    const { storage } = await freshStorage()
    await storage.writeAsset(ORIGIN, '/app.js', utf8('first'))
    const before = await storage.openAsset(ORIGIN, '/app.js')
    await storage.writeAsset(ORIGIN, '/app.js', utf8('second'))
    const after = await storage.openAsset(ORIGIN, '/app.js')

    expect(after!.identity).not.toBe(before!.identity)
    expect(await text(before!.read(0, before!.byteLength - 1))).toBe('first')
    expect(await text(after!.read(0, after!.byteLength - 1))).toBe('second')
    await before!.close()
    await after!.close()
  })

  it('keeps one identity for an untouched file', async () => {
    const { storage } = await freshStorage()
    await storage.writeAsset(ORIGIN, '/app.js', utf8('same'))
    const a = await storage.openAsset(ORIGIN, '/app.js')
    const b = await storage.openAsset(ORIGIN, '/app.js')
    expect(a!.identity).toBe(b!.identity)
    await a!.close()
    await b!.close()
  })

  it('fails the read, rather than ending short, when the file shrinks under it', async () => {
    const { storage, codeDir } = await freshStorage()
    await storage.writeAsset(ORIGIN, '/app.js', utf8('0123456789'))
    const asset = await storage.openAsset(ORIGIN, '/app.js')
    await truncate(join(codeDir, 'app.js'), 4)
    await expect(collect(asset!.read(0, 9))).rejects.toThrow()
    await asset!.close()
  })
})

describe('nodeLoaderStorage update-check record', () => {
  it('round-trips beside pin.json, never inside code/, and deletes on undefined', async () => {
    const { storage, codeDir } = await freshStorage()
    expect(await storage.readUpdateCheck(ORIGIN)).toBeUndefined()

    await storage.writeUpdateCheck(ORIGIN, { checkedAt: 42, validators: { etag: '"a"' }, manifestLeaf: `sha256:${'b'.repeat(64)}` })
    expect(await storage.readUpdateCheck(ORIGIN)).toEqual({ checkedAt: 42, validators: { etag: '"a"' }, manifestLeaf: `sha256:${'b'.repeat(64)}` })
    expect(await readFile(join(codeDir, '..', 'update-check.json'), 'utf8')).toContain('"checkedAt":42')
    await storage.pruneAssets(ORIGIN, [])
    expect(await storage.readUpdateCheck(ORIGIN)).toBeDefined()

    await storage.writeUpdateCheck(ORIGIN, undefined)
    expect(await storage.readUpdateCheck(ORIGIN)).toBeUndefined()
    await storage.writeUpdateCheck(ORIGIN, undefined)
  })

  it('reads a corrupt record as none', async () => {
    const { storage, codeDir } = await freshStorage()
    await storage.writeAsset(ORIGIN, '/x.js', utf8('x'))
    await writeFile(join(codeDir, '..', 'update-check.json'), '{not json')
    expect(await storage.readUpdateCheck(ORIGIN)).toBeUndefined()
  })
})
