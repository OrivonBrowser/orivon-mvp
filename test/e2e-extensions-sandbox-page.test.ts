// A manifest sandbox.pages document gets no chrome.* API at all in real
// Chrome -- extensions put untrusted code (templates, eval) there
// precisely because it cannot reach extension APIs. Proves UPSTREAM.md
// patch 37 end to end, against the real shell: the fixture
// (test/apps/extensions/sandbox-page/) opens its own sandbox.html as a tab
// from its own service worker on load (a sandboxed page has no chrome.* to
// drive an interaction from itself, so the extension's own initiative is
// the trigger, the same pattern test/apps/extensions/action-popup's own
// sibling probes use). A forged crx-msg claiming to be this same
// sandboxed frame is refused by the router itself --
// src/main/extensions/tests/router-sandbox-page-refusal.test.ts covers
// that directly, deterministically, since a real sandboxed page has no way
// to reach ipcRenderer at all once this fixture's own popup-less, chrome-
// less page proves the preload correctly refused to expose anything.
//
// Run with:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-extensions-sandbox-page.test.ts
import { afterAll, expect, it } from 'vitest'
import { readFileSync, writeFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { closeElectronApp, runPhase } from './e2e-helpers.js'
import { loadableManifest, readExtensionManifest } from '../src/broker/policy/extension-manifest.js'
import { serializeRegistry, type InstalledExtension } from '../src/main/extensions/registry.js'
import { resolveSlotKey } from '../src/main/extensions/install-runner.js'
import { generateId } from '../vendor/electron-chrome-web-store/src/browser/id.js'

const FIXTURE_DIR = fileURLToPath(new URL('./apps/extensions/sandbox-page', import.meta.url))
const SLOT = 'sandbox-page'

function seedSandboxPage (userDataDir: string): string {
  const rawManifest: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'))
  const parsed = readExtensionManifest(rawManifest)
  if (!parsed.ok) throw new Error(`sandbox-page fixture's manifest.json was refused: ${parsed.reason}`)
  const { manifest, stripped } = loadableManifest(rawManifest as Record<string, unknown>)
  const key = resolveSlotKey(userDataDir, SLOT)
  manifest.key = key
  const targetDir = join(userDataDir, 'extensions', SLOT, parsed.facts.version)
  cpSync(FIXTURE_DIR, targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest))
  const id = generateId(key)
  const now = Date.now()
  const entry: InstalledExtension = {
    id,
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
  return id
}

function findSandboxTab (windows: Page[], extensionId: string): Page | undefined {
  return windows.find((w) => w.url() === `chrome-extension://${extensionId}/sandbox.html`)
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 60_000

it('gives a manifest sandbox.pages document no chrome.tabs, the way real Chrome does', async () => {
  await runPhase('extensions sandbox page', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let extensionId = ''
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        seedProfile: async (dir) => { extensionId = seedSandboxPage(dir) },
        sandbox: true
      })

      const loaded = await waitFor(async () => (await (app as NonNullable<typeof app>).evaluate(
        ({ session }) => session.defaultSession.extensions.getAllExtensions().length
      )) === 1)
      check('the sandbox-page fixture is loaded into session.defaultSession at boot', loaded)

      const opened = await waitFor(() => findSandboxTab((app as NonNullable<typeof app>).windows(), extensionId) !== undefined, 15_000)
      check('the fixture opens its own sandbox.html as a tab from its service worker', opened)

      const sandboxTab = findSandboxTab(app.windows(), extensionId)
      if (sandboxTab !== undefined) {
        const settled = await waitFor(async () => await evaluateRetrying(sandboxTab, () =>
          document.documentElement.dataset.tabsQueryOutcome !== undefined
        ))
        check('the sandboxed page settles its own chrome.tabs.query attempt', settled)

        const report = await evaluateRetrying(sandboxTab, () => ({
          hasChrome: document.documentElement.dataset.hasChrome,
          hasTabs: document.documentElement.dataset.hasTabs,
          tabsQueryOutcome: document.documentElement.dataset.tabsQueryOutcome
        }))
        check('chrome.tabs is undefined in the sandboxed page', report.hasTabs === 'false', JSON.stringify(report))
        check('the sandboxed page never reached a real chrome.tabs.query call', report.tabsQueryOutcome === 'no-chrome-tabs', JSON.stringify(report))
      }
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
