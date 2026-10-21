import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installBundled } from '../install-runner.js'
import { verifyCrx3 } from '../crx.js'
import { readRegistry } from '../registry-runner.js'
import { createExtensionPrefsStore } from '../extension-prefs-runner.js'
import { FIXTURE_MANIFEST, buildCrx, fakeSession, withTempDir } from './install-runner-fixtures.js'
import type { InstallContext } from '../install-runner.js'

const NEVER_ASKED: InstallContext['prompt'] = async () => { throw new Error('the install prompt must not run for a bundled extension') }
const UBLOCK_ORIGIN_CRX = join(import.meta.dirname, '../../../../resources/default-profile/extensions/ublock-origin.crx')
const UBLOCK_ORIGIN_RELEASE_ID = 'fkgkibajhfbepljeaefdnfnegdcjomkh'

describe('installBundled', () => {
  it('installs without asking, records the pin before the load and writes the registry entry', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const crxPath = join(root, 'bundled.crx')
      writeFileSync(crxPath, buildCrx(FIXTURE_MANIFEST))
      const { session } = fakeSession()
      const prefs = createExtensionPrefsStore(null)
      const changed: string[] = []
      prefs.onChange((id) => { changed.push(id) })
      let pinnedAtLoad: boolean | null | undefined
      const original = session.extensions.loadExtension.bind(session.extensions)
      session.extensions.loadExtension = async (path, options) => {
        pinnedAtLoad = prefs.get(changed[0] ?? '').pinned
        return await original(path, options)
      }

      const outcome = await installBundled({ userDataPath, session, prompt: NEVER_ASKED, prefs, pinInstalled: () => false }, crxPath, { pinned: true })

      if (!outcome.installed) throw new Error(`install failed: ${outcome.reason}`)
      expect(pinnedAtLoad).toBe(true)
      expect(prefs.get(outcome.entry.id).pinned).toBe(true)
      expect(readRegistry(userDataPath)).toEqual([outcome.entry])
      expect(outcome.entry.source).toEqual({ kind: 'file', fileName: crxPath })
    })
  })

  it('leaves the extension unpinned when the list says so, whatever pinInstalled answers', async () => {
    await withTempDir(async (root) => {
      const crxPath = join(root, 'bundled.crx')
      writeFileSync(crxPath, buildCrx(FIXTURE_MANIFEST))
      const prefs = createExtensionPrefsStore(null)
      const outcome = await installBundled({ userDataPath: join(root, 'userData'), session: fakeSession().session, prompt: NEVER_ASKED, prefs, pinInstalled: () => true }, crxPath, { pinned: false })
      if (!outcome.installed) throw new Error('install failed')
      expect(prefs.get(outcome.entry.id).pinned).toBe(false)
    })
  })

  it('still refuses in a private runtime', async () => {
    await withTempDir(async (root) => {
      const crxPath = join(root, 'bundled.crx')
      writeFileSync(crxPath, buildCrx(FIXTURE_MANIFEST))
      const outcome = await installBundled({ userDataPath: join(root, 'userData'), session: fakeSession().session, prompt: NEVER_ASKED, privateSession: true }, crxPath, { pinned: true })
      expect(outcome.installed).toBe(false)
      expect(readRegistry(join(root, 'userData'))).toEqual([])
    })
  })

  it.skipIf(!existsSync(UBLOCK_ORIGIN_CRX))('gives the fetched uBlock Origin the id its release key signs to, the same on every profile', () => {
    expect(verifyCrx3(Buffer.from(readFileSync(UBLOCK_ORIGIN_CRX)), { requirePublisherProof: false }).id).toBe(UBLOCK_ORIGIN_RELEASE_ID)
  })
})
