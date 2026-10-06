// What every extension e2e needs to drive chrome.* from outside: seed one
// fixture into a profile, wait out the first-start recovery reload, open one
// of the extension's own pages hidden, and call a function in its service
// worker over chrome.runtime. Extension e2e launch with `sandbox: true`
// (extension-sw-preload-recovery.ts's own doc says why).
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { mainOutput } from '../support/launch-electron.mjs'
import { delay, waitFor } from '../support/smoke-helpers.mjs'
import { FIXTURES_DIR } from '../support/extensions-fixtures.js'
import { loadableManifest, readExtensionManifest } from '../../src/broker/policy/extension-manifest.js'
import { serializeRegistry, type InstalledExtension } from '../../src/main/extensions/registry.js'
import { readRegistry } from '../../src/main/extensions/registry-runner.js'
import { resolveSlotKey } from '../../src/main/extensions/install-runner.js'
import { generateId } from '../../vendor/electron-chrome-web-store/src/browser/id.js'

/** Copies `test/apps/extensions/<name>/` into the profile the way
 * install-runner.ts would have left it (the stripped manifest, with the
 * slot's key) and adds it to the registry, so the boot path under test is the
 * real one. Several calls on one profile add several extensions. Returns the
 * extension's id. */
export function seedFixture (userDataDir: string, name: string): string {
  const sourceDir = join(FIXTURES_DIR, name)
  const rawManifest: unknown = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8'))
  const parsed = readExtensionManifest(rawManifest)
  if (!parsed.ok) throw new Error(`fixture ${name}'s manifest.json was refused: ${parsed.reason}`)
  const { manifest, stripped } = loadableManifest(rawManifest as Record<string, unknown>)
  const key = resolveSlotKey(userDataDir, name)
  manifest.key = key
  const targetDir = join(userDataDir, 'extensions', name, parsed.facts.version)
  cpSync(sourceDir, targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest))
  const now = Date.now()
  const entry: InstalledExtension = {
    id: generateId(key),
    name: parsed.facts.name,
    version: parsed.facts.version,
    enabled: true,
    installedAt: now,
    updatedAt: now,
    source: { kind: 'unpacked', from: sourceDir },
    updater: { kind: 'none', reason: 'e2e fixture, seeded directly' },
    path: targetDir,
    stripped
  }
  const others = readRegistry(userDataDir).filter((existing) => existing.id !== entry.id)
  writeFileSync(join(userDataDir, 'extensions', 'registry.json'), serializeRegistry([...others, entry]))
  return entry.id
}

const RECOVERY_LINE = 'reloaded it once to recover'

/** Waits for a freshly loaded extension's one recovery reload. A page opened
 * before it is invalidated ("Extension context invalidated", most of `chrome`
 * missing), so a test opens its first extension page after this. True when
 * the line appeared; false when none came within `timeoutMs`, which a caller
 * may treat as "nothing to recover". */
export async function waitRecovered (app: ElectronApplication, timeoutMs = 20_000): Promise<boolean> {
  const seen = await waitFor(() => mainOutput(app).includes(RECOVERY_LINE), timeoutMs)
  await delay(seen ? 2_000 : 500)
  return seen
}

/** Opens `chrome-extension://<id>/<file>` in a hidden window on the default
 * session and returns its webContents id. The window stays until the app
 * closes. */
export async function openExtensionPage (app: ElectronApplication, id: string, file: string): Promise<number> {
  return await app.evaluate(async ({ session, BrowserWindow }, url: string) => {
    const win = new BrowserWindow({ show: false, webPreferences: { session: session.defaultSession, sandbox: true } })
    await win.loadURL(url)
    const keep = (globalThis as { __extensionTestWindows?: unknown[] })
    keep.__extensionTestWindows ??= []
    keep.__extensionTestWindows.push(win)
    return win.webContents.id
  }, `chrome-extension://${id}/${file}`)
}

export type RpcReply = { ok: true, result: unknown } | { ok: false, error: string }

/** Calls `path` (`chrome.tabs.query`) with `args` in the extension's service
 * worker, asked from the page whose webContents id is `wc`. The fixture's
 * rpc.js answers. */
export async function rpc (app: ElectronApplication, wc: number, path: string, args: unknown[] = []): Promise<RpcReply> {
  const script = `chrome.runtime.sendMessage({ cmd: 'call', path: ${JSON.stringify(path)}, args: ${JSON.stringify(args)} })`
  const reply = await app.evaluate(async ({ webContents }, [id, source]: [number, string]) => {
    const contents = webContents.fromId(id)
    if (contents === undefined || contents === null) return { ok: false, error: `no webContents ${String(id)}` }
    return await contents.executeJavaScript(source, true)
  }, [wc, script] as [number, string])
  return reply as RpcReply
}

/** What `stubNotifications` collected: the options of each notification an
 * extension asked for. */
export interface NotificationLog { readonly shown: () => Promise<unknown[]> }

/** Replaces the OS notification with a recording stand-in, so a test never
 * raises a real one. Reads the factory seam the notifications API builds
 * through (`__orivonDevNotificationFactory`); a no-op until that API reads
 * it. */
export async function stubNotifications (app: ElectronApplication): Promise<NotificationLog> {
  await app.evaluate(() => {
    const log: unknown[] = []
    const g = globalThis as { __orivonDevNotificationFactory?: unknown, __orivonNotificationLog?: unknown[] }
    g.__orivonNotificationLog = log
    g.__orivonDevNotificationFactory = (options: unknown) => {
      log.push(options)
      const fake = { show: () => {}, close: () => {}, on: () => fake, once: () => fake }
      return fake
    }
  })
  return {
    shown: async () => await app.evaluate(() => (globalThis as { __orivonNotificationLog?: unknown[] }).__orivonNotificationLog ?? [])
  }
}

interface Rect { x: number, y: number, width: number, height: number }

/** An extension's popup among the children of a shell window, with the window's own measures. */
export interface PopupInView { bounds: Rect, index: number, children: number, content: Rect, windows: number }

/** Where the popup of extension `id` sits, or null while it is not a child of any window. */
export async function popupView (app: ElectronApplication, id: string): Promise<PopupInView | null> {
  return await app.evaluate(({ BaseWindow }, extensionId: string) => {
    const windows = BaseWindow.getAllWindows().length
    for (const win of BaseWindow.getAllWindows()) {
      const children = win.contentView.children
      const index = children.findIndex((child) => (child as unknown as { webContents?: Electron.WebContents }).webContents?.getURL().startsWith(`chrome-extension://${extensionId}/popup.html`) === true)
      const view = children[index]
      if (view !== undefined) return { bounds: view.getBounds(), index, children: children.length, content: win.getContentBounds(), windows }
    }
    return null
  }, id)
}

/** Closes the popup of extension `id` from the main process and waits until it has left its window. */
export async function closePopup (app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ BaseWindow }, extensionId: string) => {
    for (const win of BaseWindow.getAllWindows()) {
      for (const child of win.contentView.children) {
        const contents = (child as unknown as { webContents?: Electron.WebContents }).webContents
        if (contents?.getURL().startsWith(`chrome-extension://${extensionId}/popup.html`) === true) contents.close()
      }
    }
  }, id)
  if (!(await waitFor(async () => await popupView(app, id) === null))) throw new Error('the popup did not close')
}
