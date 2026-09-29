import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readExtensionFacts } from '../extensions-view-runner.js'
import type { InstalledExtension } from '../registry.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-ext-view-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function entryAt (path: string, name = 'Fixture'): InstalledExtension {
  return {
    id: 'abcdefghijklmnopabcdefghijklmnop',
    name,
    version: '1.0.0',
    enabled: true,
    installedAt: 1000,
    updatedAt: 1000,
    source: { kind: 'unpacked', from: path },
    updater: { kind: 'none', reason: 'unpacked extensions have no update mechanism' },
    path,
    stripped: { permissions: [], optionalPermissions: [], declarativeNetRequest: undefined }
  }
}

async function writeManifest (root: string, manifest: object): Promise<void> {
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
}

describe('readExtensionFacts', () => {
  it('falls back to the registry entry\'s own name when manifest.json is missing', async () => {
    const facts = await readExtensionFacts(entryAt(dir, 'Recorded Name'))
    expect(facts.resolvedName).toBe('Recorded Name')
    expect(facts.manifestFacts).toBeUndefined()
    expect(facts.iconDataUrl).toBeUndefined()
  })

  it('reads the manifest\'s own literal name, description and facts', async () => {
    await writeManifest(dir, { manifest_version: 3, name: 'Real Name', version: '1.0.0', description: 'A description' })
    const facts = await readExtensionFacts(entryAt(dir))
    expect(facts.resolvedName).toBe('Real Name')
    expect(facts.resolvedDescription).toBe('A description')
    expect(facts.manifestFacts?.name).toBe('Real Name')
  })

  it('resolves __MSG_name__ and __MSG_description__ from _locales/<default_locale>/messages.json', async () => {
    await writeManifest(dir, {
      manifest_version: 3, name: '__MSG_extName__', version: '1.0.0', description: '__MSG_extDesc__', default_locale: 'en'
    })
    await mkdir(join(dir, '_locales', 'en'), { recursive: true })
    await writeFile(join(dir, '_locales', 'en', 'messages.json'), JSON.stringify({
      extName: { message: 'Localized Name' },
      extDesc: { message: 'Localized description' }
    }))
    const facts = await readExtensionFacts(entryAt(dir))
    expect(facts.resolvedName).toBe('Localized Name')
    expect(facts.resolvedDescription).toBe('Localized description')
  })

  it('reads the best icon at or under 48px and encodes it as a data: URL', async () => {
    await writeManifest(dir, {
      manifest_version: 3, name: 'x', version: '1.0.0',
      icons: { 16: 'icon16.png', 48: 'icon48.png', 128: 'icon128.png' }
    })
    await writeFile(join(dir, 'icon48.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const facts = await readExtensionFacts(entryAt(dir))
    expect(facts.iconDataUrl).toBe(`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`)
  })

  it('never reads an icon path that escapes the extension\'s own folder', async () => {
    await writeManifest(dir, { manifest_version: 3, name: 'x', version: '1.0.0', icons: { 48: '../../../../etc/passwd' } })
    const facts = await readExtensionFacts(entryAt(dir))
    expect(facts.iconDataUrl).toBeUndefined()
  })

  it('never throws on a manifest.json that is not valid JSON', async () => {
    await writeFile(join(dir, 'manifest.json'), '{not json')
    const facts = await readExtensionFacts(entryAt(dir, 'Recorded Name'))
    expect(facts.resolvedName).toBe('Recorded Name')
    expect(facts.manifestFacts).toBeUndefined()
  })
})
