// Shared by every e2e suite that boots the shell with extensions already
// installed: seeds a profile's registry directly, the way a person's saved
// registry replays on every start (extensions-subsystem.ts's own doc), never
// through the install UI itself.
import { createServer, type Server } from 'node:http'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadableManifest, readExtensionManifest } from '../../src/broker/policy/extension-manifest.js'
import { parseRegistry, serializeRegistry, type InstalledExtension } from '../../src/main/extensions/registry.js'
import { resolveSlotKey } from '../../src/main/extensions/install-runner.js'
import { verifyCrx3 } from '../../src/main/extensions/crx.js'
import { unpackZip } from '../../src/main/extensions/unpack-runner.js'
import { generateId } from '../../vendor/electron-chrome-web-store/src/browser/id.js'

export const FIXTURES_DIR = fileURLToPath(new URL('../apps/extensions/', import.meta.url)).replace(/[/\\]$/, '')
export const FIXTURES = ['content-marker', 'network-perms'] as const

/**
 * Copies each fixture folder into `<userData>/extensions/<slot>/<version>/`,
 * with `loadableManifest`'s stripped copy -- plus a `key` from
 * `resolveSlotKey`, the same per-slot key `install-runner.ts` itself
 * generates and persists at `<slot>/key.pub` -- in place of `manifest.json`,
 * and writes `extensions/registry.json` through `registry.ts`'s own
 * serialiser -- exactly what `install-runner.ts` would have produced, so the
 * boot path under test (`extensions-subsystem.ts` reading the registry and
 * calling `session.defaultSession.extensions.loadExtension`) is the real
 * one, never a shortcut through `installFromFolder` itself. Returns what it
 * wrote, so a caller that needs an id (to drive a toggle or a removal) does
 * not have to recompute it.
 */
export function seedExtensions (userDataDir: string, slots: readonly string[] = FIXTURES): readonly InstalledExtension[] {
  const entries: InstalledExtension[] = []
  for (const slot of slots) {
    const sourceDir = join(FIXTURES_DIR, slot)
    const rawManifest: unknown = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8'))
    const parsed = readExtensionManifest(rawManifest)
    if (!parsed.ok) throw new Error(`fixture ${slot}'s own manifest.json was refused: ${parsed.reason}`)
    const { manifest, stripped } = loadableManifest(rawManifest as Record<string, unknown>)
    const key = resolveSlotKey(userDataDir, slot)
    manifest.key = key
    const targetDir = join(userDataDir, 'extensions', slot, parsed.facts.version)
    cpSync(sourceDir, targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest))
    const now = Date.now()
    entries.push({
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
    })
  }
  writeFileSync(join(userDataDir, 'extensions', 'registry.json'), serializeRegistry(entries))
  return entries
}

/** A plain, single-page HTTP origin on an EPHEMERAL port -- never a fixed
 * one: 8875/8876/8885 are held by another process on this machine (this
 * repository's local notes). Mirrors
 * test/app-loading/e2e-session-partitions.test.ts's own `startOriginServer`. */
export async function startFixtureServer (): Promise<{ server: Server, origin: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>extensions-load-fixture</title><body>fixture</body>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return { server, origin: `http://127.0.0.1:${String(address.port)}` }
}

/** The extension Orivon ships in a new profile, as a package file: uBlock Origin, the real one. */
export const BUNDLED_UBLOCK_ORIGIN = fileURLToPath(new URL('../../resources/default-profile/extensions/ublock-origin.crx', import.meta.url))

/**
 * Installs the package at `crxPath` into the registry of `userDataDir`, the way the installer leaves it (its own key in the
 * loaded manifest, the permissions the loader strips recorded), added to what the registry already lists. Returns the entry.
 */
export function seedPackedExtension (userDataDir: string, crxPath: string, slot: string): InstalledExtension {
  const verified = verifyCrx3(readFileSync(crxPath), { requirePublisherProof: false })
  const staging = join(userDataDir, 'extensions', `${slot}.unpacked`)
  unpackZip(verified.archive, staging)
  const rawManifest = JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8')) as Record<string, unknown>
  const parsed = readExtensionManifest(rawManifest)
  if (!parsed.ok) throw new Error(`${crxPath}'s manifest.json was refused: ${parsed.reason}`)
  const { manifest, stripped } = loadableManifest(rawManifest)
  manifest.key = verified.developerPublicKey.toString('base64')
  const targetDir = join(userDataDir, 'extensions', slot, parsed.facts.version)
  mkdirSync(join(userDataDir, 'extensions', slot), { recursive: true })
  cpSync(staging, targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest))
  const now = Date.now()
  const entry: InstalledExtension = {
    id: verified.id,
    name: parsed.facts.name,
    version: parsed.facts.version,
    enabled: true,
    installedAt: now,
    updatedAt: now,
    source: { kind: 'unpacked', from: crxPath },
    updater: { kind: 'none', reason: 'e2e fixture, seeded directly' },
    path: targetDir,
    stripped
  }
  const registryPath = join(userDataDir, 'extensions', 'registry.json')
  const earlier = existsSync(registryPath) ? parseRegistry(readFileSync(registryPath, 'utf8')).entries : []
  writeFileSync(registryPath, serializeRegistry([...earlier, entry]))
  return entry
}
