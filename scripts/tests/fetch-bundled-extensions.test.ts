import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchBundledExtensions, prepareBundledExtensions } from '../fetch-bundled-extensions.mjs'

const BYTES = Buffer.from('a pretend extension')
const DIGEST = createHash('sha256').update(BYTES).digest('hex')

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fetch-bundled-'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'bundled-extensions.json'), JSON.stringify([{ file: 'x.crx', name: 'X', version: '1', url: 'https://example.invalid/x.crx', sha256: DIGEST, pinned: true }]))
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const answering = (bytes: Buffer, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 404, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }))

describe('fetch-bundled-extensions', () => {
  it('keeps a download that matches its pinned digest and asks nobody again once it is there', async () => {
    const fetchImpl = answering(BYTES)
    expect(await fetchBundledExtensions(dir, fetchImpl)).toEqual([])
    expect(await readFile(join(dir, 'extensions', 'x.crx'))).toEqual(BYTES)
    expect(await fetchBundledExtensions(dir, fetchImpl)).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('keeps nothing from a download whose digest differs, and says so', async () => {
    const failures = await fetchBundledExtensions(dir, answering(Buffer.from('tampered')))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('sha256')
    expect(await readdir(join(dir, 'extensions'))).toEqual([])
  })

  it('reports an HTTP failure as one line', async () => {
    const failures = await fetchBundledExtensions(dir, answering(BYTES, false))
    expect(failures).toEqual([expect.stringContaining('HTTP 404')])
  })
})

describe('prepareBundledExtensions', () => {
  const unpacking = () => ({ prepareBundledFolder: vi.fn() })

  it('unpacks a fetched extension that has no folder, loading the unpacking once for all', async () => {
    await mkdir(join(dir, 'extensions'), { recursive: true })
    await writeFile(join(dir, 'extensions', 'x.crx'), BYTES)
    const tool = unpacking()
    const load = vi.fn(async () => tool)
    expect(await prepareBundledExtensions(dir, load)).toEqual([])
    expect(tool.prepareBundledFolder).toHaveBeenCalledWith(join(dir, 'extensions'), 'x.crx', 'x', DIGEST)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does nothing, and loads nothing, for a folder that already comes from the pinned file', async () => {
    await mkdir(join(dir, 'extensions', 'x'), { recursive: true })
    await writeFile(join(dir, 'extensions', 'x.crx'), BYTES)
    await writeFile(join(dir, 'extensions', 'x', 'manifest.json'), '{}')
    await writeFile(join(dir, 'extensions', 'x.bundled.json'), JSON.stringify({ sha256: DIGEST, manifest: {} }))
    const load = vi.fn(async () => unpacking())
    expect(await prepareBundledExtensions(dir, load)).toEqual([])
    expect(load).not.toHaveBeenCalled()
  })

  it('unpacks again when the record names another file, or the folder lost its manifest', async () => {
    await mkdir(join(dir, 'extensions', 'x'), { recursive: true })
    await writeFile(join(dir, 'extensions', 'x.crx'), BYTES)
    await writeFile(join(dir, 'extensions', 'x.bundled.json'), JSON.stringify({ sha256: 'f'.repeat(64), manifest: {} }))
    await writeFile(join(dir, 'extensions', 'x', 'manifest.json'), '{}')
    const tool = unpacking()
    await prepareBundledExtensions(dir, async () => tool)
    expect(tool.prepareBundledFolder).toHaveBeenCalledTimes(1)

    await writeFile(join(dir, 'extensions', 'x.bundled.json'), JSON.stringify({ sha256: DIGEST, manifest: {} }))
    await rm(join(dir, 'extensions', 'x', 'manifest.json'))
    await prepareBundledExtensions(dir, async () => tool)
    expect(tool.prepareBundledFolder).toHaveBeenCalledTimes(2)
  })

  it('leaves out an extension whose file was not fetched, which the fetch already reported', async () => {
    const load = vi.fn(async () => unpacking())
    expect(await prepareBundledExtensions(dir, load)).toEqual([])
    expect(load).not.toHaveBeenCalled()
  })

  it('reports a file that cannot be unpacked as one line, and a tool that cannot be loaded the same', async () => {
    await mkdir(join(dir, 'extensions'), { recursive: true })
    await writeFile(join(dir, 'extensions', 'x.crx'), BYTES)
    const refusing = { prepareBundledFolder: vi.fn(() => { throw new Error('not a signed extension') }) }
    expect(await prepareBundledExtensions(dir, async () => refusing)).toEqual([expect.stringContaining('could not unpack X 1: not a signed extension')])
    expect(await prepareBundledExtensions(dir, async () => { throw new Error('esbuild is missing') })).toEqual([expect.stringContaining('esbuild is missing')])
  })
})
