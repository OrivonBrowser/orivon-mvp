// A fresh install's or an update's dNR rules must be live in the SAME
// process immediately, with no restart (extensions-dnr.ts's own
// registerPendingDnrInstall doc), and a preload-recovery reload must not
// look, to this listener, like a real unload (its beginDnrReload doc).
// Driven against the real attachExtensionsDnr + installFromFolder, with a
// fake Session that actually fires 'extension-loaded'/'extension-unloaded'
// the way Electron's own session.extensions does (install-runner.test.ts's
// own fake session does not need to fire them for ITS tests, so it does
// not; this suite is exactly the case that does).
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Session } from 'electron'
import {
  attachExtensionsDnr,
  beginDnrReload,
  endDnrReload,
  getCachedStrippedPermissions,
  getDnrEngine,
  hasFeedbackCapableExtension,
  onDnrActiveChange,
  registerPendingDnrInstall,
} from '../extensions-dnr.js'
import { installFromFolder, type InstallContext } from '../install-runner.js'
import type { InstalledExtension } from '../registry.js'
import { generateId } from '../../../../vendor/electron-chrome-web-store/src/browser/id.js'
import type { DnrRequest } from '../dnr/types.js'

/** A `Session` fake that behaves enough like Electron's real
 * `session.extensions` to reproduce the bugs this file guards: `loadExtension` reads the
 * manifest's own `key` (finishInstall always writes one) to derive the same
 * id `generateId` would, and actually fires `'extension-loaded'`/
 * `'extension-unloaded'` to whatever attachExtensionsDnr subscribed --
 * install-runner.test.ts's own fake does not need to, so it does not. */
function fakeSession(): { session: Session } {
  const listeners = new Map<string, Array<(event: unknown, extension: { id: string }) => void>>()
  const pathById = new Map<string, string>()
  const on = (event: string, cb: (event: unknown, extension: { id: string }) => void): void => {
    const arr = listeners.get(event) ?? []
    arr.push(cb)
    listeners.set(event, arr)
  }
  const fire = (event: string, extension: { id: string }): void => {
    for (const cb of listeners.get(event) ?? []) cb({}, extension)
  }
  const session = {
    extensions: {
      on,
      loadExtension: async (path: string) => {
        const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as { key: string, name: string }
        const id = generateId(manifest.key)
        pathById.set(id, path)
        const extension = { id, name: manifest.name, manifest, path, url: `chrome-extension://${id}/` }
        fire('extension-loaded', extension)
        return extension
      },
      removeExtension: (id: string) => {
        pathById.delete(id)
        fire('extension-unloaded', { id })
      },
      getExtension: (id: string) => {
        const path = pathById.get(id)
        return path === undefined ? undefined : { id, path }
      },
    },
  } as unknown as Session
  return { session }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-extensions-dnr-test-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const ALWAYS_ALLOW: InstallContext['prompt'] = async () => true

function writeDnrFixture(root: string, ruleId: number): string {
  const dir = join(root, 'dnr-fixture')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'dNR fixture',
      version: '1.0.0',
      permissions: ['declarativeNetRequest'],
      declarative_net_request: { rule_resources: [{ id: 'r1', enabled: true, path: 'rules.json' }] },
    })
  )
  writeFileSync(
    join(dir, 'rules.json'),
    JSON.stringify([
      { id: ruleId, priority: 1, action: { type: 'block' }, condition: { urlFilter: '/ads/*.js', resourceTypes: ['script'] } },
    ])
  )
  return dir
}

function blockRequest(url: string): DnrRequest {
  return { url, method: 'get', resourceType: 'script', tabId: 1, frameId: 0 }
}

describe('a fresh install\'s dNR rules are live with no restart', () => {
  it('installFromFolder\'s own extension-loaded already blocks, before writeRegistry ever runs', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const engine = attachExtensionsDnr(session, userDataPath)
      const source = writeDnrFixture(root, 1)

      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return

      // Same engine instance installFromFolder's own 'extension-loaded'
      // fired into -- registry.json was written only AFTER this resolved,
      // so a stale/empty registry read could never have produced this.
      expect(engine.evaluate(blockRequest('http://x.example/ads/blocked.js')).cancel).toBe(true)
      expect(getDnrEngine()).toBe(engine)
      expect(getCachedStrippedPermissions(outcome.entry.id)).toEqual(['declarativeNetRequest'])
    })
  })

  it('an update\'s NEW rules are live immediately, not the old version\'s', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const engine = attachExtensionsDnr(session, userDataPath)
      const source = writeDnrFixture(root, 1)

      const first = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(first.installed).toBe(true)
      if (!first.installed) return
      expect(engine.evaluate(blockRequest('http://x.example/ads/blocked.js')).cancel).toBe(true)
      // Not yet blocking the NEW path the update below adds a rule for.
      expect(engine.evaluate(blockRequest('http://x.example/trackers/new.js')).cancel).toBeUndefined()

      // A same-slot update: new version, a rule for a different path, same
      // id (source folder decides the slot). At this point in a real
      // install, registry.json still holds the OLD entry -- finishInstall
      // does not call writeRegistry until after this load resolves.
      writeFileSync(
        join(source, 'manifest.json'),
        JSON.stringify({
          manifest_version: 3,
          name: 'dNR fixture',
          version: '2.0.0',
          permissions: ['declarativeNetRequest'],
          declarative_net_request: { rule_resources: [{ id: 'r1', enabled: true, path: 'rules.json' }] },
        })
      )
      writeFileSync(
        join(source, 'rules.json'),
        JSON.stringify([{ id: 2, priority: 1, action: { type: 'block' }, condition: { urlFilter: '/trackers/*.js', resourceTypes: ['script'] } }])
      )
      const second = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(second.installed).toBe(true)
      if (!second.installed) return
      expect(second.entry.id).toBe(first.entry.id)

      expect(engine.evaluate(blockRequest('http://x.example/trackers/new.js')).cancel).toBe(true)
    })
  })

  it('registerPendingDnrInstall alone (no session at all) is exactly what finishInstall now calls before loadExtension', () => {
    // Narrower unit check of the exported seam itself, independent of a
    // fake session: registering a pending entry, then delivering
    // 'extension-loaded' for its id, is what install-runner.ts's
    // finishInstall relies on -- this proves the seam's own contract
    // (pending entry wins over an empty/stale registry) without going
    // through installFromFolder at all.
    const userDataPath = mkdtempSync(join(tmpdir(), 'orivon-extensions-dnr-seam-test-'))
    try {
      // No registry.json at all -- readRegistry (registry-runner.ts) treats
      // a missing file as "nothing installed yet" ([]), exactly the state a
      // fresh install's own registry.json is in when 'extension-loaded'
      // fires (finishInstall writes it only after loadExtension resolves).
      let loadedHandler: ((event: unknown, extension: { id: string }) => void) | undefined
      const session = {
        extensions: { on: (event: string, cb: typeof loadedHandler) => { if (event === 'extension-loaded') loadedHandler = cb } },
      } as unknown as Session
      attachExtensionsDnr(session, userDataPath)

      const entryPath = join(userDataPath, 'extensions', 'pending-slot', '1.0.0')
      mkdirSync(entryPath, { recursive: true })
      writeFileSync(join(entryPath, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'pending', version: '1.0.0' }))
      const entry: InstalledExtension = {
        id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        name: 'pending',
        version: '1.0.0',
        enabled: true,
        installedAt: 0,
        updatedAt: 0,
        source: { kind: 'unpacked', from: '/x' },
        updater: { kind: 'none', reason: 'test' },
        path: entryPath,
        stripped: { permissions: ['declarativeNetRequest', 'declarativeNetRequestFeedback'], optionalPermissions: [], declarativeNetRequest: undefined },
      }
      registerPendingDnrInstall(entry)
      loadedHandler?.({}, { id: entry.id })

      expect(getCachedStrippedPermissions(entry.id)).toEqual(['declarativeNetRequest', 'declarativeNetRequestFeedback'])
      expect(hasFeedbackCapableExtension()).toBe(true)
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})

describe('a recovery reload does not look like a real unload to the dNR service', () => {
  it('beginDnrReload/endDnrReload keeps session rules, badge/permission cache and webRequest registration across a remove+load of the SAME id', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const engine = attachExtensionsDnr(session, userDataPath)
      const source = writeDnrFixture(root, 1)

      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return
      const id = outcome.entry.id

      // Session rules the extension itself would add at runtime, and the
      // permission the webRequest-registration gate below watches for.
      engine.updateSessionRules(id, { addRules: [{ id: 900, priority: 1, action: { type: 'block' }, condition: { urlFilter: '/session-only.js', resourceTypes: ['script'] } }] })
      let active: boolean | undefined
      onDnrActiveChange((value) => { active = value })
      expect(active).toBe(true)

      // extension-sw-preload-recovery.ts's own remove-then-load, marked
      // exactly as watchForMissedServiceWorkerPreload's onReloadBoundary
      // wiring does.
      beginDnrReload(id)
      session.extensions.removeExtension(id)
      // The webRequest registration must not have dropped mid-reload.
      expect(active).toBe(true)
      await session.extensions.loadExtension(outcome.entry.path, { allowFileAccess: false })
      endDnrReload(id)

      // Session rules (never touched by removeExtension during the marked
      // window) and the static block rule (re-applied by the paired
      // 'extension-loaded', harmlessly) are both still live.
      expect(engine.evaluate(blockRequest('http://x.example/session-only.js')).cancel).toBe(true)
      expect(engine.evaluate(blockRequest('http://x.example/ads/blocked.js')).cancel).toBe(true)
      expect(active).toBe(true)
    })
  })

  it('an UNMARKED unload (a real disable/uninstall) still tears everything down, same as before', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const engine = attachExtensionsDnr(session, userDataPath)
      const source = writeDnrFixture(root, 1)
      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return

      let active: boolean | undefined
      onDnrActiveChange((value) => { active = value })
      expect(active).toBe(true)

      session.extensions.removeExtension(outcome.entry.id)
      expect(active).toBe(false)
      expect(engine.evaluate(blockRequest('http://x.example/ads/blocked.js')).cancel).toBeUndefined()
      expect(getCachedStrippedPermissions(outcome.entry.id)).toEqual([])
    })
  })
})
