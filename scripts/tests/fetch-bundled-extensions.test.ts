import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error: an .mjs script with no declaration file
import { fetchBundledExtensions } from '../fetch-bundled-extensions.mjs'

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
