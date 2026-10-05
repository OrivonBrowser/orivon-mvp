import { describe, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { installFromFolder, type InstallContext } from '../install-runner.js'
import { setEnabled, uninstall } from '../install-lifecycle.js'
import { readRegistry } from '../registry-runner.js'
import { behaviorPath, writeOpenOnActionClick } from '../side-panel-behavior-file.js'
import { ALWAYS_ALLOW, FIXTURE_MANIFEST, fakeSession, withTempDir, writeFixtureFolder } from './install-runner-fixtures.js'

describe('uninstall / setEnabled', () => {
  it('uninstall removes the session extension, the folder, and the registry entry', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session, loaded } = fakeSession()
      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return

      await uninstall({ userDataPath, session, prompt: ALWAYS_ALLOW }, outcome.entry.id)
      expect(loaded.has(outcome.entry.id)).toBe(false)
      expect(existsSync(outcome.entry.path)).toBe(false)
      expect(readRegistry(userDataPath)).toEqual([])
    })
  })

  it('uninstall empties chrome.storage while the extension is still loaded, then its web storage', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session, loaded, clearedStorage } = fakeSession()
      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return
      const stillLoaded: boolean[] = []

      await uninstall({
        userDataPath,
        session,
        prompt: ALWAYS_ALLOW,
        clearExtensionStorage: async (id) => { stillLoaded.push(loaded.has(id)) }
      }, outcome.entry.id)

      expect(stillLoaded).toEqual([true])
      expect(clearedStorage).toEqual([{ origin: `chrome-extension://${outcome.entry.id}` }])
      expect(readRegistry(userDataPath)).toEqual([])
    })
  })

  it('uninstall goes on when the extension has no chrome.storage to empty', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session, loaded } = fakeSession()
      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return

      await uninstall({
        userDataPath,
        session,
        prompt: ALWAYS_ALLOW,
        clearExtensionStorage: async () => { throw new Error('chrome.storage is undefined') }
      }, outcome.entry.id)

      expect(loaded.has(outcome.entry.id)).toBe(false)
      expect(readRegistry(userDataPath)).toEqual([])
    })
  })

  it('setEnabled(false) unloads from the session and flips the registry flag; setEnabled(true) reloads it', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session, loaded } = fakeSession()
      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return

      await setEnabled({ userDataPath, session, prompt: ALWAYS_ALLOW }, outcome.entry.id, false)
      expect(loaded.has(outcome.entry.id)).toBe(false)
      expect(readRegistry(userDataPath)[0]?.enabled).toBe(false)

      await setEnabled({ userDataPath, session, prompt: ALWAYS_ALLOW }, outcome.entry.id, true)
      expect(loaded.has(outcome.entry.id)).toBe(true)
      expect(readRegistry(userDataPath)[0]?.enabled).toBe(true)
    })
  })

  it('a setEnabled whose loadExtension is still pending does not lose a concurrent uninstall of a different entry, or vice versa', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const sourceA = writeFixtureFolder(join(root, 'a'), FIXTURE_MANIFEST)
      const sourceB = writeFixtureFolder(join(root, 'b'), FIXTURE_MANIFEST)
      const { session, loaded } = fakeSession()

      const a = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, sourceA)
      const b = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, sourceB)
      expect(a.installed && b.installed).toBe(true)
      if (!a.installed || !b.installed) return
      await setEnabled({ userDataPath, session, prompt: ALWAYS_ALLOW }, a.entry.id, false)
      expect(readRegistry(userDataPath)).toHaveLength(2)

      // A session whose loadExtension for A's re-enable does not resolve
      // until this test says so -- the same gap `finishInstall`'s own
      // prompt/loadExtension await leaves open, where the pre-fix code read
      // the registry before this gap and wrote it back stale after.
      let releaseLoad: () => void = () => {}
      const gate = new Promise<void>((resolve) => { releaseLoad = resolve })
      const slowSession = {
        extensions: {
          loadExtension: async (path: string) => {
            await gate
            return await (session.extensions.loadExtension as (p: string) => Promise<{ id: string, name: string, manifest: object, path: string, url: string }>)(path)
          },
          removeExtension: session.extensions.removeExtension,
          getExtension: session.extensions.getExtension
        }
      } as unknown as InstallContext['session']

      const enablePromise = setEnabled({ userDataPath, session: slowSession, prompt: ALWAYS_ALLOW }, a.entry.id, true)
      // Queued behind the still-pending setEnabled call above -- it must not
      // start its own read until setEnabled's own write has landed.
      const uninstallPromise = uninstall({ userDataPath, session, prompt: ALWAYS_ALLOW }, b.entry.id)

      releaseLoad()
      await enablePromise
      await uninstallPromise

      const registry = readRegistry(userDataPath)
      expect(registry).toHaveLength(1)
      expect(registry[0]?.id).toBe(a.entry.id)
      expect(registry[0]?.enabled).toBe(true)
      expect(loaded.has(a.entry.id)).toBe(true)
      expect(loaded.has(b.entry.id)).toBe(false)
      expect(existsSync(b.entry.path)).toBe(false)
    })
  })
})

describe('uninstall and the side panel', () => {
  it('closes the extension\'s side panels before its storage is emptied, while it is still loaded', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session, loaded } = fakeSession()
      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return
      const order: string[] = []

      await uninstall({
        userDataPath,
        session,
        prompt: ALWAYS_ALLOW,
        closeSidePanels: async (id) => { order.push(`close:${id}:${String(loaded.has(id))}`) },
        clearExtensionStorage: async () => { order.push('clear') }
      }, outcome.entry.id)

      expect(order).toEqual([`close:${outcome.entry.id}:true`, 'clear'])
    })
  })

  it('removes the saved toolbar behaviour with the extension', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session } = fakeSession()
      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return
      const slot = dirname(outcome.entry.path)
      writeOpenOnActionClick(slot, true)
      expect(existsSync(behaviorPath(slot))).toBe(true)

      await uninstall({ userDataPath, session, prompt: ALWAYS_ALLOW }, outcome.entry.id)

      expect(existsSync(behaviorPath(slot))).toBe(false)
    })
  })
})
