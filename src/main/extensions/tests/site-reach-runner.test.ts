import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extensionNamesForOrigin } from '../site-reach-runner.js'
import type { InstalledExtension } from '../registry.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-site-reach-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const NEVER_CACHED = (): boolean => false

function entryAt (path: string, name: string, enabled = true): InstalledExtension {
  return {
    id: `${name.toLowerCase().replace(/\s+/g, '-')}-id-000000000000000`.slice(0, 32),
    name,
    version: '1.0.0',
    enabled,
    installedAt: 1000,
    updatedAt: 1000,
    source: { kind: 'unpacked', from: path },
    updater: { kind: 'none', reason: 'unpacked extensions have no update mechanism' },
    path,
    stripped: { permissions: [], optionalPermissions: [], declarativeNetRequest: undefined }
  }
}

async function writeManifest (root: string, manifest: object): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
}

describe('extensionNamesForOrigin', () => {
  it('names an enabled extension whose manifest host_permissions covers the origin', async () => {
    const extDir = join(dir, 'covers')
    await writeManifest(extDir, { manifest_version: 3, name: 'Covers', version: '1.0.0', host_permissions: ['<all_urls>'] })
    const list = { list: () => [entryAt(extDir, 'Covers')] }
    const names = await extensionNamesForOrigin(list, 'https://a.example', NEVER_CACHED)
    expect(names).toEqual(['Covers'])
  })

  it('leaves out a disabled extension entirely', async () => {
    const extDir = join(dir, 'disabled')
    await writeManifest(extDir, { manifest_version: 3, name: 'Disabled', version: '1.0.0', host_permissions: ['<all_urls>'] })
    const list = { list: () => [entryAt(extDir, 'Disabled', false)] }
    const names = await extensionNamesForOrigin(list, 'https://a.example', NEVER_CACHED)
    expect(names).toEqual([])
  })

  it('leaves out an extension whose manifest never reaches the origin', async () => {
    const extDir = join(dir, 'narrow')
    await writeManifest(extDir, { manifest_version: 3, name: 'Narrow', version: '1.0.0', host_permissions: ['https://other.example/*'] })
    const list = { list: () => [entryAt(extDir, 'Narrow')] }
    const names = await extensionNamesForOrigin(list, 'https://a.example', NEVER_CACHED)
    expect(names).toEqual([])
  })

  it('returns none, and reads no manifest, for an origin served from its pinned cache', async () => {
    const extDir = join(dir, 'cached-case')
    await writeManifest(extDir, { manifest_version: 3, name: 'Would Cover', version: '1.0.0', host_permissions: ['<all_urls>'] })
    let listed = false
    const list = { list: () => { listed = true; return [entryAt(extDir, 'Would Cover')] } }
    const names = await extensionNamesForOrigin(list, 'https://a.example', () => true)
    expect(names).toEqual([])
    expect(listed).toBe(false)
  })
})
