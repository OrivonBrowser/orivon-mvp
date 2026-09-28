// The extension boot path end to end: the registry is seeded directly (no
// install UI drives this test) and the real shell boots from it, the same
// way a person's saved registry replays on every start
// (extensions-subsystem.ts's own doc).
//
// Fixtures: test/apps/extensions/content-marker/ (a MAIN... no, an
// ISOLATED-world content script on <all_urls> that marks the page) and
// test/apps/extensions/network-perms/ (declares every permission
// loadableManifest must strip: webRequest, declarativeNetRequest,
// nativeMessaging, plus a static ruleset and a service worker).
//
// The seeded page is served from an EPHEMERAL port this file's own server
// picks (never a fixed one): 8875/8876/8885 were found held by another
// process on this machine when this file was written (orivon-ports' own
// serve, per this repo's local notes), and this suite needs no fixture this
// repository's OTHER e2e files already keep on a fixed port either.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-extensions-load.test.ts
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
import { SHELL_PARTITION } from '../src/main/shell/shell-session.js'

const FIXTURES_DIR = fileURLToPath(new URL('./apps/extensions/', import.meta.url)).replace(/[/\\]$/, '')
const FIXTURES = ['content-marker', 'network-perms'] as const

/**
 * Copies each fixture folder into `<userData>/extensions/<slot>/<version>/`,
 * with `loadableManifest`'s stripped copy in place of `manifest.json`, and
 * writes `extensions/registry.json` through `registry.ts`'s own serialiser
 * -- exactly what `install-runner.ts` would have produced, so the boot path
 * under test (`extensions-subsystem.ts` reading the registry and calling
 * `session.defaultSession.extensions.loadExtension`) is the real one, never
 * a shortcut through `installFromFolder` itself.
 */
function seedExtensions (userDataDir: string): void {
  const entries: InstalledExtension[] = []
  for (const slot of FIXTURES) {
    const sourceDir = join(FIXTURES_DIR, slot)
    const rawManifest: unknown = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8'))
    const parsed = readExtensionManifest(rawManifest)
    if (!parsed.ok) throw new Error(`fixture ${slot}'s own manifest.json was refused: ${parsed.reason}`)
    const { manifest, stripped } = loadableManifest(rawManifest as Record<string, unknown>)
    const targetDir = join(userDataDir, 'extensions', slot, parsed.facts.version)
    cpSync(sourceDir, targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest))
    const now = Date.now()
    entries.push({
      id: `${slot}-fixture-id`,
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
}

/** A plain, single-page HTTP origin on an EPHEMERAL port -- see this
 * file's header for why never a fixed one. Mirrors
 * test/e2e-session-partitions.test.ts's own `startOriginServer`. */
async function startFixtureServer (): Promise<{ server: Server, origin: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>extensions-load-fixture</title><body>fixture</body>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return { server, origin: `http://127.0.0.1:${String(address.port)}` }
}

let server: Server | undefined

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const WAIT_BUDGET_MS = 8_000 + 20_000 + 20_000
const TEST_TIMEOUT_MS = WAIT_BUDGET_MS + 40_000

it('loads every enabled registry entry at boot: a content script runs, network permissions were stripped, net.fetch still works, the shell partition stays clean, and an extension page gets no window.orivon', async () => {
  const started = await startFixtureServer()
  server = started.server
  const fixtureUrl = `${started.origin}/`

  await runPhase('extensions load at boot', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        seedProfile: async (dir) => { seedExtensions(dir) }
      })

      // ---- (b) both fixtures loaded into the default session ----
      const loaded = await waitFor(async () => (await (app as NonNullable<typeof app>).evaluate(
        ({ session }) => session.defaultSession.extensions.getAllExtensions().length
      )) === 2)
      check('both fixture extensions are loaded into session.defaultSession at boot', loaded)

      const extensions = await app.evaluate(({ session }) =>
        session.defaultSession.extensions.getAllExtensions().map((extension) => ({
          id: extension.id, name: extension.name, manifest: extension.manifest as Record<string, unknown>
        }))
      )
      const networkPerms = extensions.find((extension) => extension.name === 'Orivon E2E Network Perms')
      const contentMarker = extensions.find((extension) => extension.name === 'Orivon E2E Content Marker')
      check('the network-perms fixture is among the loaded extensions', networkPerms !== undefined)
      check('the content-marker fixture is among the loaded extensions', contentMarker !== undefined)

      if (networkPerms !== undefined) {
        const permissions = [
          ...(networkPerms.manifest['permissions'] as string[] | undefined ?? []),
          ...(networkPerms.manifest['optional_permissions'] as string[] | undefined ?? [])
        ]
        const stripped = permissions.some((p) => p === 'nativeMessaging' || p.startsWith('webRequest') || p.startsWith('declarativeNetRequest'))
        check('the loaded network-perms manifest has no webRequest/declarativeNetRequest/nativeMessaging permission', !stripped, JSON.stringify(permissions))
        check('the loaded network-perms manifest has no declarative_net_request key', networkPerms.manifest['declarative_net_request'] === undefined)
      }

      // ---- (c) net.fetch on the default session still works, and the process survives ----
      const fetchResult = await app.evaluate(async ({ net }, url: string) => {
        try {
          const response = await net.fetch(url)
          return { ok: response.ok, status: response.status }
        } catch (error) {
          return { ok: false, status: 0, error: String(error) }
        }
      }, fixtureUrl)
      check('net.fetch on the default session succeeds with both extensions loaded', fetchResult.ok, JSON.stringify(fetchResult))
      const alive = await app.evaluate(({ app }) => typeof app.getVersion() === 'string')
      check('the main process is still alive after that net.fetch', alive)

      // ---- (d) the shell partition never receives an extension ----
      const shellExtensionCount = await app.evaluate(({ session }, partition: string) =>
        session.fromPartition(partition).extensions.getAllExtensions().length, SHELL_PARTITION)
      check('the persist:orivon-shell partition has zero extensions loaded', shellExtensionCount === 0, `saw ${String(shellExtensionCount)}`)

      // ---- (a) the content script actually ran on a normal tab ----
      const view = await navigateToFixture(app, fixtureUrl, 'extensions-load-fixture')
      const marker = await waitFor(async () => await evaluateRetrying(view, () => document.documentElement.dataset['orivonExtensionMarker']) === 'ran')
      check('the content-marker fixture\'s content script ran on an ordinary tab', marker)

      // ---- (e) an extension's own page gets no window.orivon ----
      if (contentMarker !== undefined) {
        const optionsUrl = `chrome-extension://${contentMarker.id}/options.html`
        await view.goto(optionsUrl)
        const landedUrl = await evaluateRetrying(view, () => location.href)
        check('the tab actually navigated to the extension\'s options page', landedUrl === optionsUrl, landedUrl)
        const orivonType = await evaluateRetrying(view, () => typeof (window as unknown as { orivon?: unknown }).orivon)
        check('window.orivon is undefined on the extension\'s own options page', orivonType === 'undefined', orivonType)
      }
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
