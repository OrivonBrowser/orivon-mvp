// Shared setup for the e2e files that put test/apps/freetube/ into a real shell:
// the installed-app run (e2e-freetube-app.test.ts, `pinRealApp` +
// `grantAndServe`) and the live-origin run (e2e-freetube-live-origin.test.ts,
// `grantOriginOnly`). One copy, so the two cannot drift in how they set up
// the app they each claim to test.
//
// The bundle is built from the REAL files on disk, never a fixture shaped
// like them, so what gets pinned is what ships.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { forwardOutput } from './e2e-helpers.js'
import { bundleTree } from '../../src/broker/policy/bundle-hash.js'
import type { BundleEntry } from '../../src/broker/policy/bundle-hash.js'
import { fromBundleTree } from '../../src/broker/policy/pin.js'
import { nodeLoaderStorage } from '../../src/loader/cache/node-storage.js'

export const FREETUBE_ORIGIN = 'https://freetube-e2e.orivon.test'
const APP_DIR = join(process.cwd(), 'test', 'apps', 'freetube')

/**
 * `serve.mjs` is a plain static file server rooted at `APP_DIR` -- so
 * asPage's (e2e-helpers.ts) own dynamic-script requirement is met by
 * writing straight to a file under that root, never by teaching serve.mjs
 * a new route (it stays "a file server that executes no logic of its own",
 * this file's own header). `/.well-known/`-adjacent name, deliberately
 * outside it, so it is never mistaken for part of the real app's manifest.
 */
const AS_PAGE_SCRIPT_PATH = join(APP_DIR, '__as-page-script.js')
export const AS_PAGE_SCRIPT_URL = '__as-page-script.js'
export function setFreetubeAsPageScript (js: string): void { writeFileSync(AS_PAGE_SCRIPT_PATH, js, 'utf8') }
/** Best-effort: never written yet, or an earlier run already cleaned it up. */
export function clearFreetubeAsPageScript (): void { try { unlinkSync(AS_PAGE_SCRIPT_PATH) } catch { /* nothing to remove */ } }

/**
 * Ports for the servers these tests spawn -- deliberately NOT 8874/8875, which
 * are the ports a person running `test/apps/freetube` by hand, or `orivon-port
 * serve freetube` in the sibling ports checkout, is already using. A test
 * sharing one would test that person's server instead.
 */
export const PORT_APP_FREETUBE = 8877
export const PORT_APP_FREETUBE_REAL = 8876

const SERVER_START_TIMEOUT_MS = 10_000

/**
 * Spawns one of the static servers under `test/apps/` and resolves only once THAT
 * process reports it is serving. Waiting on the port alone is not enough: it
 * accepts any listener, so a server orphaned by an earlier timed-out run would
 * silently become the server under test -- and a timeout is exactly what
 * leaves one behind. An exit before serving (`EADDRINUSE`) rejects at once.
 */
export async function startOwnServer (label: string, script: string, args: readonly string[]): Promise<ChildProcess> {
  const child = spawn(process.execPath, [script, ...args], { stdio: 'pipe' })
  // A test that times out never reaches its own `finally`, so its server
  // would outlive the run and hold the port against the next one.
  process.once('exit', () => { child.kill() })
  forwardOutput(label, child)
  let output = ''
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${label}: no "serving" line within ${String(SERVER_START_TIMEOUT_MS)}ms\n${output}`))
    }, SERVER_START_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      output += String(chunk)
      if (output.includes(' serving ')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => { output += String(chunk) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`${label} exited (code ${String(code)}) before serving -- is an earlier run's server still holding the port?\n${output}`))
    })
  })
  return child
}

export interface PinnedApp {
  readonly manifest: Record<string, unknown>
  readonly fileCount: number
}

/**
 * `extra`: additional pinned assets alongside the real app's own files --
 * serving is driven by the PIN's own asset tree (`pin.ts`'s `hasAsset`),
 * not the manifest's declared `assets` list, so an extra path pinned here
 * is servable the same as any real one. Exists for an INSTALLED app's own
 * window.orivon calls (ADR-0045; main-world-socket.ts's README.md Design
 * notes): unlike a live origin's plain static server (asPage's own
 * setFreetubeAsPageScript, above), a pinned bundle is hash-verified, so a
 * script it needs must be part of the pin from the start, not written to
 * disk afterward -- e2e-freetube-app.test.ts's own DETECTED_SCRIPT/
 * DIAL_PROBE_SCRIPT.
 */
export async function pinRealApp (userDataDir: string, extra: readonly BundleEntry[] = []): Promise<PinnedApp> {
  const manifestText = await readFile(join(APP_DIR, '.well-known', 'orivon.json'), 'utf8')
  const manifest = JSON.parse(manifestText) as { entry: string, assets?: string[], version: string }
  const paths = [manifest.entry, ...(manifest.assets ?? [])]

  const entries: BundleEntry[] = [{ path: '/.well-known/orivon.json', content: new TextEncoder().encode(manifestText) }, ...extra]
  for (const path of paths) {
    entries.push({ path: `/${path}`, content: new Uint8Array(await readFile(join(APP_DIR, path))) })
  }

  const storage = nodeLoaderStorage(userDataDir)
  const tree = await bundleTree(entries)
  for (const entry of entries) await storage.writeAsset(FREETUBE_ORIGIN, entry.path, entry.content)
  await storage.writePin(FREETUBE_ORIGIN, fromBundleTree(FREETUBE_ORIGIN, tree.root, tree.assets, manifest.version, 0))
  return { manifest: manifest as unknown as Record<string, unknown>, fileCount: entries.length }
}

export async function readAppManifest (): Promise<Record<string, unknown>> {
  const text = await readFile(join(APP_DIR, '.well-known', 'orivon.json'), 'utf8')
  return JSON.parse(text) as Record<string, unknown>
}

/**
 * Registers `origin` as an app and issues the grants its manifest declares --
 * and NOTHING ELSE. No pin, no cached bundle, no `registerServingFor`, so the
 * page keeps loading from whatever server actually hosts it.
 *
 * This is the shape a grant is supposed to have: capabilities attach to the
 * ORIGIN, and installing (pinning a hash-verified bundle, ADR-0007/ADR-0009)
 * is a separate feature layered on top, not a precondition. `tab-view.ts`'s
 * `appTabArgsFor` already agrees -- it gates the app-tab flag, and therefore
 * routed fetch, on `broker.app.isRegisteredSync(origin)` alone.
 *
 * Issues what accepting the consent prompt would, without the prompt, for a
 * test that is about what a granted origin can do rather than how it is
 * granted. The prompt itself is exercised by e2e-loopback-grant.test.ts.
 */
export async function grantOriginOnly (
  evaluate: <T, A>(fn: (electron: unknown, arg: A) => Promise<T>, arg: A) => Promise<T>,
  manifest: Record<string, unknown>,
  origin: string
): Promise<{ hooksPresent: boolean }> {
  return await evaluate(async (_electron, payload: { origin: string, manifest: unknown }) => {
    const globals = globalThis as unknown as { __orivonDevGrant?: (request: unknown) => Promise<unknown> }
    if (typeof globals.__orivonDevGrant !== 'function') return { hooksPresent: false }
    const capabilities = (payload.manifest as { capabilities: { net: { https: { connect: string[] } } } }).capabilities
    await globals.__orivonDevGrant({
      origin: payload.origin,
      manifest: payload.manifest,
      capability: 'https.connect',
      patterns: capabilities.net.https.connect
    })
    await globals.__orivonDevGrant({ origin: payload.origin, manifest: payload.manifest, capability: 'fs', patterns: [] })
    return { hooksPresent: true }
  }, { origin, manifest })
}

/**
 * Issues the grants the manifest declares and registers serving, through the
 * dev-only hooks a `scripts/build-e2e.mjs` build installs. This stands in for
 * the install-time consent dialog, which a real install would show and which
 * no `.test` origin can ever reach: `install-origin.ts` refuses it, and it is
 * not a loopback literal, so the developer-mode path never applies either.
 */
export async function grantAndServe (
  evaluate: <T, A>(fn: (electron: unknown, arg: A) => Promise<T>, arg: A) => Promise<T>,
  manifest: Record<string, unknown>
): Promise<{ hooksPresent: boolean }> {
  return await evaluate(async (_electron, payload: { origin: string, manifest: unknown }) => {
    const globals = globalThis as unknown as {
      __orivonDevRegisterServing?: (origin: string) => Promise<void>
      __orivonDevGrant?: (request: unknown) => Promise<unknown>
    }
    if (typeof globals.__orivonDevRegisterServing !== 'function' || typeof globals.__orivonDevGrant !== 'function') {
      return { hooksPresent: false }
    }
    const capabilities = (payload.manifest as { capabilities: { net: { https: { connect: string[] } } } }).capabilities
    await globals.__orivonDevGrant({
      origin: payload.origin,
      manifest: payload.manifest,
      capability: 'https.connect',
      patterns: capabilities.net.https.connect
    })
    await globals.__orivonDevGrant({
      origin: payload.origin,
      manifest: payload.manifest,
      capability: 'fs',
      patterns: []
    })
    await globals.__orivonDevRegisterServing(payload.origin)
    return { hooksPresent: true }
  }, { origin: FREETUBE_ORIGIN, manifest })
}
