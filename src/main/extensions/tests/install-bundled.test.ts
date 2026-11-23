import { describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installBundled, installFromFile } from '../install-runner.js'
import { uninstall } from '../install-lifecycle.js'
import { prepareBundledFolder, readBundledRecord, type BundledRecord } from '../bundled-folder.js'
import { verifyCrx3 } from '../crx.js'
import { readRegistry } from '../registry-runner.js'
import { createExtensionPrefsStore } from '../extension-prefs-runner.js'
import { FIXTURE_MANIFEST, buildCrx, fakeSession, makeRsaKeyPair, withTempDir, type KeyPair } from './install-runner-fixtures.js'
import type { InstallContext } from '../install-runner.js'

const NEVER_ASKED: InstallContext['prompt'] = async () => { throw new Error('the install prompt must not run for a bundled extension') }
const UBLOCK_ORIGIN_CRX = join(import.meta.dirname, '../../../../resources/default-profile/extensions/ublock-origin.crx')
const UBLOCK_ORIGIN_RELEASE_ID = 'fkgkibajhfbepljeaefdnfnegdcjomkh'

/** What the build leaves for a bundled extension: `a.crx` unpacked into `a`, with its record, under `<root>/default-profile/extensions/`. */
function bundle (root: string, manifest: Record<string, unknown> = FIXTURE_MANIFEST, developer?: KeyPair): { folder: string, path: string, record: BundledRecord } {
  const extensionsDir = join(root, 'default-profile', 'extensions')
  mkdirSync(extensionsDir, { recursive: true })
  const bytes = buildCrx(manifest, developer)
  writeFileSync(join(extensionsDir, 'a.crx'), bytes)
  prepareBundledFolder(extensionsDir, 'a.crx', 'a', createHash('sha256').update(bytes).digest('hex'))
  const record = readBundledRecord(extensionsDir, 'a') as BundledRecord
  return { folder: 'a', path: join(extensionsDir, 'a'), record }
}

describe('installBundled', () => {
  it('loads the extension from its own folder and writes none of it into the profile, without asking', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const bundled = bundle(root)
      const { session, loaded } = fakeSession()
      const prefs = createExtensionPrefsStore(null)
      const changed: string[] = []
      prefs.onChange((id) => { changed.push(id) })
      let pinnedAtLoad: boolean | null | undefined
      const original = session.extensions.loadExtension.bind(session.extensions)
      session.extensions.loadExtension = async (path, options) => {
        pinnedAtLoad = prefs.get(changed[0] ?? '').pinned
        return await original(path, options)
      }

      const outcome = await installBundled({ userDataPath, session, prompt: NEVER_ASKED, prefs, pinInstalled: () => false }, bundled, { pinned: true })

      if (!outcome.installed) throw new Error(`install failed: ${outcome.reason}`)
      expect(pinnedAtLoad).toBe(true)
      expect(prefs.get(outcome.entry.id).pinned).toBe(true)
      expect(readRegistry(userDataPath)).toEqual([outcome.entry])
      expect(outcome.entry.source).toEqual({ kind: 'bundled', folder: 'a' })
      expect(outcome.entry.path).toBe(bundled.path)
      expect([...loaded.values()]).toEqual([bundled.path])
      // The registry is the one file the profile got: no copy of the extension, no base manifest, no key file.
      expect(existsSync(join(userDataPath, 'extensions', outcome.entry.id))).toBe(false)
    })
  })

  it('gives the extension the id its developer key signs to', async () => {
    await withTempDir(async (root) => {
      const developer = makeRsaKeyPair()
      const bundled = bundle(root, FIXTURE_MANIFEST, developer)
      const outcome = await installBundled({ userDataPath: join(root, 'userData'), session: fakeSession().session, prompt: NEVER_ASKED }, bundled, { pinned: false })
      if (!outcome.installed) throw new Error(outcome.reason)
      const expected = verifyCrx3(buildCrx(FIXTURE_MANIFEST, developer), { requirePublisherProof: false }).id
      expect(outcome.entry.id).toBe(expected)
    })
  })

  it('leaves the extension unpinned when the list says so, whatever pinInstalled answers', async () => {
    await withTempDir(async (root) => {
      const prefs = createExtensionPrefsStore(null)
      const outcome = await installBundled({ userDataPath: join(root, 'userData'), session: fakeSession().session, prompt: NEVER_ASKED, prefs, pinInstalled: () => true }, bundle(root), { pinned: false })
      if (!outcome.installed) throw new Error('install failed')
      expect(prefs.get(outcome.entry.id).pinned).toBe(false)
    })
  })

  it('still refuses in a private runtime', async () => {
    await withTempDir(async (root) => {
      const outcome = await installBundled({ userDataPath: join(root, 'userData'), session: fakeSession().session, prompt: NEVER_ASKED, privateSession: true }, bundle(root), { pinned: true })
      expect(outcome.installed).toBe(false)
      expect(readRegistry(join(root, 'userData'))).toEqual([])
    })
  })

  it('refuses a folder whose manifest is not the one its record gives, and leaves the folder as it was', async () => {
    await withTempDir(async (root) => {
      const bundled = bundle(root)
      const manifestPath = join(bundled.path, 'manifest.json')
      writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('"Fixture Extension"', '"Somebody Else"'))
      const { session, loaded } = fakeSession()
      await expect(installBundled({ userDataPath: join(root, 'userData'), session, prompt: NEVER_ASKED }, bundled, { pinned: false })).rejects.toThrow('not the one its record gives')
      expect(loaded.size).toBe(0)
      expect(existsSync(manifestPath)).toBe(true)
      expect(readRegistry(join(root, 'userData'))).toEqual([])
    })
  })

  it('never deletes the application\'s folder when the load fails', async () => {
    await withTempDir(async (root) => {
      const bundled = bundle(root)
      const { session, setFailNextLoad } = fakeSession()
      setFailNextLoad(new Error('load failed'))
      await expect(installBundled({ userDataPath: join(root, 'userData'), session, prompt: NEVER_ASKED }, bundled, { pinned: false })).rejects.toThrow('load failed')
      expect(existsSync(join(bundled.path, 'manifest.json'))).toBe(true)
      expect(readRegistry(join(root, 'userData'))).toEqual([])
    })
  })

  it('is replaced by a newer file of the same extension, which is then the person\'s and leaves the application\'s folder alone', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const developer = makeRsaKeyPair()
      const bundled = bundle(root, FIXTURE_MANIFEST, developer)
      const { session, loaded } = fakeSession()
      const context: InstallContext = { userDataPath, session, prompt: async () => true }
      const first = await installBundled(context, bundled, { pinned: false })
      if (!first.installed) throw new Error(first.reason)

      const newer = join(root, 'newer.crx')
      writeFileSync(newer, buildCrx({ ...FIXTURE_MANIFEST, version: '2.0.0' }, developer))
      const second = await installFromFile(context, newer)
      if (!second.installed) throw new Error(second.reason)

      expect(second.entry.id).toBe(first.entry.id)
      expect(second.entry.version).toBe('2.0.0')
      expect(second.entry.source.kind).toBe('file')
      expect(second.entry.installedAt).toBe(first.entry.installedAt)
      expect(second.entry.path).toBe(join(userDataPath, 'extensions', first.entry.id, '2.0.0'))
      expect(readRegistry(userDataPath)).toEqual([second.entry])
      expect(loaded.get(first.entry.id)).toBe(second.entry.path)
      expect(existsSync(join(bundled.path, 'manifest.json'))).toBe(true)
    })
  })

  it('is not replaced by a file with no signature, which could carry its key', async () => {
    await withTempDir(async (root) => {
      const bundled = bundle(root)
      const context: InstallContext = { userDataPath: join(root, 'userData'), session: fakeSession().session, prompt: async () => true }
      const first = await installBundled(context, bundled, { pinned: false })
      if (!first.installed) throw new Error(first.reason)
      const zip = join(root, 'same-key.zip')
      const archive = new AdmZip()
      archive.addFile('manifest.json', Buffer.from(JSON.stringify({ ...FIXTURE_MANIFEST, version: '9.0.0', key: (bundled.record.manifest as { key: string }).key })))
      archive.writeZip(zip)
      const refused = await installFromFile(context, zip)
      expect(refused.installed).toBe(false)
      expect(readRegistry(join(root, 'userData'))).toEqual([first.entry])
    })
  })

  it('goes when the person removes it, and the application\'s folder stays for the next profile', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const bundled = bundle(root)
      const { session, removedIds } = fakeSession()
      const context: InstallContext = { userDataPath, session, prompt: NEVER_ASKED }
      const outcome = await installBundled(context, bundled, { pinned: false })
      if (!outcome.installed) throw new Error(outcome.reason)

      await uninstall(context, outcome.entry.id)

      expect(removedIds).toContain(outcome.entry.id)
      expect(readRegistry(userDataPath)).toEqual([])
      expect(existsSync(join(bundled.path, 'manifest.json'))).toBe(true)
    })
  })

  it.skipIf(!existsSync(UBLOCK_ORIGIN_CRX))('gives the fetched uBlock Origin the id its release key signs to, the same on every profile', () => {
    expect(verifyCrx3(Buffer.from(readFileSync(UBLOCK_ORIGIN_CRX)), { requirePublisherProof: false }).id).toBe(UBLOCK_ORIGIN_RELEASE_ID)
  })
})
