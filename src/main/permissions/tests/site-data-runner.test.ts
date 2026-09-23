import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { directorySizeBytes } from '../site-data-runner.js'

// The Cookies and site data page's disk-size figures -- Orivon's own
// storage (private files, pinned code), never a site's browser storage
// (that needs a live webContents; see this file's own header). A fresh,
// self-contained walker rather than the loader's own private `walkFiles`
// (`node-storage.ts`): that one returns paths for `pruneAssets` to act on,
// not sizes, and its log wording names that caller specifically.

describe('directorySizeBytes', () => {
  it('0 for a root that does not exist yet -- nothing stored, not an error', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'orivon-site-data-')), 'never-created')
    expect(await directorySizeBytes(root)).toBe(0)
  })

  it('0 for an empty, existing directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orivon-site-data-'))
    expect(await directorySizeBytes(root)).toBe(0)
  })

  it('sums the bytes of every file directly inside the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orivon-site-data-'))
    await writeFile(join(root, 'a.txt'), 'a'.repeat(10))
    await writeFile(join(root, 'b.txt'), 'b'.repeat(20))

    expect(await directorySizeBytes(root)).toBe(30)
  })

  it('recurses into subdirectories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orivon-site-data-'))
    await mkdir(join(root, 'nested', 'deeper'), { recursive: true })
    await writeFile(join(root, 'top.txt'), 'x'.repeat(5))
    await writeFile(join(root, 'nested', 'mid.txt'), 'y'.repeat(7))
    await writeFile(join(root, 'nested', 'deeper', 'bottom.txt'), 'z'.repeat(3))

    expect(await directorySizeBytes(root)).toBe(15)
  })
})
