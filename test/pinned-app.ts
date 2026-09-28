// Serves a fixture app the way an installed one is served: its files pinned
// in the loader's cache, a grant issued through the developer-only hook, and
// the origin registered for serving. Shared by the e2e suites that need a
// real served CSP and a real broker under a page they wrote.

import type { ElectronApplication } from 'playwright'
import esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import { bundleTree } from '../src/broker/policy/bundle-hash.js'
import type { BundleEntry } from '../src/broker/policy/bundle-hash.js'
import { fromBundleTree } from '../src/broker/policy/pin.js'
import { nodeLoaderStorage } from '../src/loader/cache/node-storage.js'
import { shimEsbuildPlugin } from '../src/shim/tests/support/shim-esbuild-plugin.js'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { CapabilityKind, Grant, Manifest } from '../src/contracts/index.js'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

/** Bundles a page or Worker script against src/shim/, as a port's bundler would. */
export async function bundleForApp (entry: string, format: 'iife' | 'esm' = 'iife'): Promise<Uint8Array> {
  const built = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    format,
    target: 'es2022',
    write: false,
    absWorkingDir: REPO_ROOT,
    plugins: [shimEsbuildPlugin()],
    logLevel: 'silent'
  })
  const [output] = built.outputFiles
  if (output === undefined) throw new Error(`esbuild produced no output for ${entry}`)
  return output.contents
}

/** A further grant `serveApp` issues, beside its first. */
export interface ExtraGrant { readonly capability: CapabilityKind, readonly patterns: readonly string[] }

/** Pins `files` (paths from the origin's root) with the manifest, grants `capability` over `patterns` and each of `extra`, and registers the origin. */
export async function serveApp (app: ElectronApplication, origin: string, manifest: Manifest, capability: CapabilityKind, files: Record<string, Uint8Array>, patterns: readonly string[] = [], extra: readonly ExtraGrant[] = []): Promise<{ granted: boolean, registered: boolean }> {
  const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  const storage = nodeLoaderStorage(userDataDir)
  const entries: BundleEntry[] = [
    { path: '/.well-known/orivon.json', content: new TextEncoder().encode(JSON.stringify(manifest)) },
    ...Object.entries(files).map(([path, content]) => ({ path, content }))
  ]
  const tree = await bundleTree(entries)
  for (const entry of entries) await storage.writeAsset(origin, entry.path, entry.content)
  await storage.writePin(origin, fromBundleTree(origin, tree.root, tree.assets, manifest.version, 0))
  let granted = true
  for (const grant of [{ capability, patterns }, ...extra]) {
    granted &&= await app.evaluate(async (_electron, request: DevGrantRequest) => {
      const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
      if (typeof hook !== 'function') return false
      await hook(request)
      return true
    }, { origin, manifest, capability: grant.capability, patterns: [...grant.patterns] } satisfies DevGrantRequest)
  }
  const registered = await app.evaluate(async (_electron, target: string) => {
    const hook = (globalThis as unknown as { __orivonDevRegisterServing?: (origin: string) => Promise<void> }).__orivonDevRegisterServing
    if (typeof hook !== 'function') return false
    await hook(target)
    return true
  }, origin)
  return { granted, registered }
}
