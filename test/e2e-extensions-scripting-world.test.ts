// Content scripts a service worker registers at run time with
// chrome.scripting.registerContentScripts, in the page's own world (MAIN) and
// in the isolated one. A content blocker registers its scriptlets this way.
// Fixture: test/apps/extensions/scripting-world/.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-extensions-scripting-world.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'
import { loadableManifest, readExtensionManifest } from '../src/broker/policy/extension-manifest.js'
import { serializeRegistry, type InstalledExtension } from '../src/main/extensions/registry.js'
import { resolveSlotKey } from '../src/main/extensions/install-runner.js'
import { generateId } from '../vendor/electron-chrome-web-store/src/browser/id.js'

const FIXTURE_DIR = fileURLToPath(new URL('./apps/extensions/scripting-world/', import.meta.url)).replace(/[/\\]$/, '')

function seedFixture (userDataDir: string): InstalledExtension {
  const rawManifest: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'))
  const parsed = readExtensionManifest(rawManifest)
  if (!parsed.ok) throw new Error(`scripting-world fixture's own manifest.json was refused: ${parsed.reason}`)
  const { manifest, stripped } = loadableManifest(rawManifest as Record<string, unknown>)
  const slot = 'scripting-world'
  const key = resolveSlotKey(userDataDir, slot)
  manifest.key = key
  const targetDir = join(userDataDir, 'extensions', slot, parsed.facts.version)
  cpSync(FIXTURE_DIR, targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest))
  const now = Date.now()
  const entry: InstalledExtension = {
    id: generateId(key),
    name: parsed.facts.name,
    version: parsed.facts.version,
    enabled: true,
    installedAt: now,
    updatedAt: now,
    source: { kind: 'unpacked', from: FIXTURE_DIR },
    updater: { kind: 'none', reason: 'e2e fixture, seeded directly' },
    path: targetDir,
    stripped
  }
  writeFileSync(join(userDataDir, 'extensions', 'registry.json'), serializeRegistry([entry]))
  return entry
}

let server: Server | undefined

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const SW_SETTLE_MS = 8_000
const TEST_TIMEOUT_MS = 120_000

it('runs a content script registered at run time in the page\'s own world and another in the isolated one', async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>scripting-world-fixture</title><body>fixture</body>')
  })
  await new Promise<void>((resolve) => { server?.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  const fixtureUrl = `http://127.0.0.1:${String(address.port)}/`

  await runPhase('extensions scripting world', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], seedProfile: async (dir) => { seedFixture(dir) }, sandbox: true })
      await new Promise((resolve) => setTimeout(resolve, SW_SETTLE_MS))

      const view = await navigateToFixture(app, fixtureUrl, 'scripting-world-fixture')
      const attributes = await waitFor(async () => await evaluateRetrying(view, () =>
        document.documentElement.getAttribute('data-isolated-world') === 'ran'
      ), 10_000).catch(() => false)
      check('the isolated-world script ran', attributes)
      const seen = await evaluateRetrying(view, () => ({
        mainAttribute: document.documentElement.getAttribute('data-main-world'),
        mainGlobal: (window as unknown as { __markedFromMainWorld?: boolean }).__markedFromMainWorld === true,
        isolatedGlobal: (window as unknown as { __markedFromIsolatedWorld?: boolean }).__markedFromIsolatedWorld === true
      }))
      check('the MAIN-world script ran and set a global the page can read', seen.mainGlobal, JSON.stringify(seen))
      check('the isolated script\'s global stays out of the page', !seen.isolatedGlobal, JSON.stringify(seen))
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
