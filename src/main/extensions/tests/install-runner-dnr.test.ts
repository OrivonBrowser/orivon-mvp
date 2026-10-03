// How install-runner.ts hands an install to the declarativeNetRequest
// service: the pending entry exists before the extension loads and is gone
// again when the load fails, and an uninstall clears the slot's persisted
// rule state but not its key. Self-contained, like install-runner-safety.

import { describe, expect, it, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { generateId } from '../../../../vendor/electron-chrome-web-store/src/browser/id.js'

const dnr = vi.hoisted(() => ({ order: [] as string[] }))
vi.mock('../extensions-dnr.js', () => ({
  registerPendingDnrInstall: (entry: { id: string }) => { dnr.order.push(`register:${entry.id}`) },
  clearPendingDnrInstall: (id: string) => { dnr.order.push(`clear:${id}`) }
}))

import { installFromFolder, type InstallContext } from '../install-runner.js'
import { uninstall } from '../install-lifecycle.js'

const ALWAYS_ALLOW: InstallContext['prompt'] = async () => true
const MANIFEST = { manifest_version: 3, name: 'Fixture Extension', version: '1.0.0', permissions: ['storage'] }

async function withTempDir (fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-install-runner-dnr-test-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeFolder (root: string): string {
  const dir = join(root, 'unpacked')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(MANIFEST))
  return dir
}

function fakeSession (failLoad = false): InstallContext['session'] {
  const loaded = new Map<string, string>()
  return {
    extensions: {
      loadExtension: async (path: string) => {
        dnr.order.push('load')
        if (failLoad) throw new Error('boom')
        const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as { key?: string }
        const id = manifest.key !== undefined ? generateId(manifest.key) : createHash('sha256').update(path).digest('hex').slice(0, 32)
        loaded.set(id, path)
        return { id, name: 'fake', manifest: {}, path, url: `chrome-extension://${id}/` }
      },
      removeExtension: (id: string) => { loaded.delete(id) },
      getExtension: (id: string) => loaded.has(id) ? { id } : undefined
    }
  } as unknown as InstallContext['session']
}

describe('install-runner and the declarativeNetRequest service', () => {
  it('registers the entry before the extension loads', async () => {
    dnr.order.length = 0
    await withTempDir(async (root) => {
      const outcome = await installFromFolder({ userDataPath: join(root, 'u'), session: fakeSession(), prompt: ALWAYS_ALLOW }, writeFolder(root))
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return
      expect(dnr.order).toEqual([`register:${outcome.entry.id}`, 'load'])
    })
  })

  it('clears the pending entry when the load fails', async () => {
    dnr.order.length = 0
    await withTempDir(async (root) => {
      await expect(installFromFolder({ userDataPath: join(root, 'u'), session: fakeSession(true), prompt: ALWAYS_ALLOW }, writeFolder(root))).rejects.toThrow('boom')
      expect(dnr.order).toHaveLength(3)
      expect(dnr.order[0]).toMatch(/^register:/)
      expect(dnr.order[1]).toBe('load')
      expect(dnr.order[2]).toBe(dnr.order[0]?.replace('register:', 'clear:'))
    })
  })

  it('uninstall clears the slot\'s persisted dynamic rules, enabled-ruleset and badge-count choices, but keeps key.pub', async () => {
    await withTempDir(async (root) => {
      const ctx = { userDataPath: join(root, 'u'), session: fakeSession(), prompt: ALWAYS_ALLOW }
      const outcome = await installFromFolder(ctx, writeFolder(root))
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return
      const slotDir = dirname(outcome.entry.path)
      const dynamic = join(slotDir, 'dnr-dynamic.json')
      const enabled = join(slotDir, 'dnr-enabled-rulesets.json')
      const badge = join(slotDir, 'dnr-badge-count.json')
      writeFileSync(dynamic, '[]')
      writeFileSync(enabled, '[]')
      writeFileSync(badge, 'true')

      await uninstall(ctx, outcome.entry.id)

      expect(existsSync(dynamic)).toBe(false)
      expect(existsSync(enabled)).toBe(false)
      expect(existsSync(badge)).toBe(false)
      expect(existsSync(join(slotDir, 'key.pub'))).toBe(true)
    })
  })

  it('uninstall does not throw when the slot never had persisted rule state', async () => {
    await withTempDir(async (root) => {
      const ctx = { userDataPath: join(root, 'u'), session: fakeSession(), prompt: ALWAYS_ALLOW }
      const outcome = await installFromFolder(ctx, writeFolder(root))
      if (!outcome.installed) throw new Error('install refused')
      await expect(uninstall(ctx, outcome.entry.id)).resolves.toBeUndefined()
    })
  })
})

describe('install-runner and the rulesets an update enables', () => {
  async function installed (root: string, version: string, ctx: InstallContext, folder: string): Promise<{ slotDir: string }> {
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ ...MANIFEST, version }))
    const outcome = await installFromFolder(ctx, folder)
    if (!outcome.installed) throw new Error('install refused')
    return { slotDir: dirname(outcome.entry.path) }
  }

  it('drops the enabled-ruleset choice when the version changes, and keeps the dynamic rules', async () => {
    await withTempDir(async (root) => {
      const ctx = { userDataPath: join(root, 'u'), session: fakeSession(), prompt: ALWAYS_ALLOW }
      const folder = writeFolder(root)
      const { slotDir } = await installed(root, '1.0.0', ctx, folder)
      writeFileSync(join(slotDir, 'dnr-enabled-rulesets.json'), '["old"]')
      writeFileSync(join(slotDir, 'dnr-dynamic.json'), '[]')

      await installed(root, '2.0.0', ctx, folder)

      expect(existsSync(join(slotDir, 'dnr-enabled-rulesets.json'))).toBe(false)
      expect(existsSync(join(slotDir, 'dnr-dynamic.json'))).toBe(true)
    })
  })

  it('keeps the choice on a reinstall of the same version', async () => {
    await withTempDir(async (root) => {
      const ctx = { userDataPath: join(root, 'u'), session: fakeSession(), prompt: ALWAYS_ALLOW }
      const folder = writeFolder(root)
      const { slotDir } = await installed(root, '1.0.0', ctx, folder)
      writeFileSync(join(slotDir, 'dnr-enabled-rulesets.json'), '["old"]')

      await installed(root, '1.0.0', ctx, folder)

      expect(readFileSync(join(slotDir, 'dnr-enabled-rulesets.json'), 'utf8')).toBe('["old"]')
    })
  })

  it('puts the choice back when the new version fails to load', async () => {
    await withTempDir(async (root) => {
      const folder = writeFolder(root)
      const { slotDir } = await installed(root, '1.0.0', { userDataPath: join(root, 'u'), session: fakeSession(), prompt: ALWAYS_ALLOW }, folder)
      writeFileSync(join(slotDir, 'dnr-enabled-rulesets.json'), '["old"]')

      const failing = { userDataPath: join(root, 'u'), session: fakeSession(true), prompt: ALWAYS_ALLOW }
      writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ ...MANIFEST, version: '2.0.0' }))
      await expect(installFromFolder(failing, folder)).rejects.toThrow('boom')

      expect(readFileSync(join(slotDir, 'dnr-enabled-rulesets.json'), 'utf8')).toBe('["old"]')
    })
  })
})
