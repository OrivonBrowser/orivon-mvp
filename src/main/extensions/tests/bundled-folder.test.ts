import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundledManifestText, prepareBundledFolder, readBundledRecord } from '../bundled-folder.js'
import { FIXTURE_MANIFEST, buildCrx, withTempDir } from './install-runner-fixtures.js'

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const UBLOCK_ORIGIN_CRX = join(import.meta.dirname, '../../../../resources/default-profile/extensions/ublock-origin.crx')

function crxIn (root: string, manifest: Record<string, unknown> = FIXTURE_MANIFEST): { dir: string, sha256: string } {
  const dir = join(root, 'extensions')
  mkdirSync(dir, { recursive: true })
  const bytes = buildCrx(manifest)
  writeFileSync(join(dir, 'a.crx'), bytes)
  return { dir, sha256: digest(bytes) }
}

describe('prepareBundledFolder', () => {
  it('unpacks a signed extension beside its file, with the manifest an install would load and a record of where it came from', async () => {
    await withTempDir(async (root) => {
      const { dir, sha256 } = crxIn(root, { ...FIXTURE_MANIFEST, permissions: ['storage', 'webRequest'] })
      expect(prepareBundledFolder(dir, 'a.crx', 'a', sha256)).toBe(true)

      const record = readBundledRecord(dir, 'a')
      expect(record?.sha256).toBe(sha256)
      expect(typeof record?.manifest['key']).toBe('string')
      // The record keeps what the file held; the folder holds what an install loads, with the blocked permission gone.
      expect(record?.manifest['permissions']).toEqual(['storage', 'webRequest'])
      const loaded = JSON.parse(readFileSync(join(dir, 'a', 'manifest.json'), 'utf8')) as Record<string, unknown>
      expect(loaded['permissions']).toEqual(['storage'])
      expect(readFileSync(join(dir, 'a', 'manifest.json'), 'utf8')).toBe(bundledManifestText(record!))
      expect(readdirSync(dir).sort()).toEqual(['a', 'a.bundled.json', 'a.crx'])
    })
  })

  it('leaves a folder that comes from the same file alone, and unpacks again for another', async () => {
    await withTempDir(async (root) => {
      const { dir, sha256 } = crxIn(root)
      expect(prepareBundledFolder(dir, 'a.crx', 'a', sha256)).toBe(true)
      const before = statSync(join(dir, 'a', 'manifest.json')).ino
      expect(prepareBundledFolder(dir, 'a.crx', 'a', sha256)).toBe(false)
      expect(statSync(join(dir, 'a', 'manifest.json')).ino).toBe(before)

      const next = crxIn(root, { ...FIXTURE_MANIFEST, version: '2.0.0' })
      expect(prepareBundledFolder(next.dir, 'a.crx', 'a', next.sha256)).toBe(true)
      expect(JSON.parse(readFileSync(join(dir, 'a', 'manifest.json'), 'utf8')).version).toBe('2.0.0')
      expect(readdirSync(dir).filter((name) => name.includes('next'))).toEqual([])
    })
  })

  it('removes the working folder an earlier killed build left, so a package never carries it', async () => {
    await withTempDir(async (root) => {
      const { dir, sha256 } = crxIn(root)
      mkdirSync(join(dir, 'a.next-deadbeef'))
      writeFileSync(join(dir, 'a.next-deadbeef', 'half.js'), '')
      prepareBundledFolder(dir, 'a.crx', 'a', sha256)
      expect(readdirSync(dir).sort()).toEqual(['a', 'a.bundled.json', 'a.crx'])
    })
  })

  it('refuses a file that is not a signed extension, and writes nothing for it', async () => {
    await withTempDir(async (root) => {
      const dir = join(root, 'extensions')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'bad.crx'), 'not a crx')
      expect(() => prepareBundledFolder(dir, 'bad.crx', 'bad', 'f'.repeat(64))).toThrow()
      expect(readdirSync(dir)).toEqual(['bad.crx'])
    })
  })

  it('has no record to read for a folder nobody unpacked, or a record that is not its shape', async () => {
    await withTempDir(async (root) => {
      expect(readBundledRecord(root, 'a')).toBeUndefined()
      writeFileSync(join(root, 'a.bundled.json'), JSON.stringify({ sha256: 5 }))
      expect(readBundledRecord(root, 'a')).toBeUndefined()
      writeFileSync(join(root, 'a.bundled.json'), '{')
      expect(readBundledRecord(root, 'a')).toBeUndefined()
    })
  })

  it.skipIf(!existsSync(UBLOCK_ORIGIN_CRX))('unpacks the pinned uBlock Origin into the folder the build ships, with the key of its release signature', async () => {
    await withTempDir(async (root) => {
      const dir = join(root, 'extensions')
      mkdirSync(dir, { recursive: true })
      const bytes = readFileSync(UBLOCK_ORIGIN_CRX)
      writeFileSync(join(dir, 'ublock-origin.crx'), bytes)
      prepareBundledFolder(dir, 'ublock-origin.crx', 'ublock-origin', digest(bytes))
      const record = readBundledRecord(dir, 'ublock-origin')!
      const loaded = JSON.parse(readFileSync(join(dir, 'ublock-origin', 'manifest.json'), 'utf8')) as { permissions: string[], key: string }
      expect(loaded.key).toBe(record.manifest['key'])
      expect(loaded.permissions).not.toContain('webRequestBlocking')
      expect(existsSync(join(dir, 'ublock-origin', 'background.html'))).toBe(true)
    })
  })
})
