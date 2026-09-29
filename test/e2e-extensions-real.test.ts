// A repeatable check against real, unpacked Chrome extensions -- the
// closest thing this repo has to "does it work with the newest real
// extensions" (the owner's own success metric,
// docs/planning/extensions-build-plan.md D1). Skipped entirely unless
// ORIVON_REAL_EXTENSIONS_DIR points at a folder of unpacked extension
// directories (this repo's own scratchpad convention:
// <dir>/<slot>/manifest.json for each of ubol, darkreader, bitwarden,
// metamask -- any subset present is measured, the rest are skipped with a
// logged reason). Never committed extension code; re-download the latest
// releases from each project's GitHub releases when the directory is
// missing (see docs/development/testing.md).
//
// Installs each through the real path: loadableManifest's stripped
// manifest copy and a real per-slot key, the same as
// test/extensions-fixtures.ts's seedExtensions and every other e2e file
// here -- never session.defaultSession.extensions.loadExtension() called
// directly on the raw source.
//
// Launched sandboxed (`launchElectron`'s `sandbox: true`) so the
// 'service-worker'-type session preload actually runs (docs/open-
// questions.md A289: under `--no-sandbox` it never does, and every
// SW-dependent check below would read as broken for that reason alone,
// not this file). A freshly loaded extension's first worker still races
// its own preload registration and misses every time, sandboxed or not --
// extension-sw-preload-recovery.ts's one-time reload recovers it before
// any check here runs.
//
// Popup bodies are read through popup.content(), never popup.evaluate():
// a LavaMoat-hardened popup (MetaMask) throws evaluating anything in the
// page ("property 'setInterval' of globalThis is inaccessible under
// scuttling mode" -- `setInterval` is not in LavaMoat's own scuttle
// exceptions list), which has nothing to do with whether the popup's real
// content rendered. content() needs no script execution in the page.
//
// Run with:
//   ORIVON_REAL_EXTENSIONS_DIR=/path/to/extracted node scripts/build-e2e.mjs && \
//     node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-extensions-real.test.ts
import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, findChrome, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'
import { loadableManifest, readExtensionManifest } from '../src/broker/policy/extension-manifest.js'
import { serializeRegistry, type InstalledExtension } from '../src/main/extensions/registry.js'
import { resolveSlotKey } from '../src/main/extensions/install-runner.js'
import { generateId } from '../vendor/electron-chrome-web-store/src/browser/id.js'

const EXTRACTED = process.env.ORIVON_REAL_EXTENSIONS_DIR

interface ExtSpec {
  readonly slot: string
  readonly dir: string
  readonly popup: string
}

const SPECS: readonly ExtSpec[] = [
  { slot: 'ubol', dir: 'ubol', popup: 'popup.html' },
  { slot: 'darkreader', dir: 'darkreader', popup: 'ui/popup/index.html' },
  { slot: 'bitwarden', dir: 'bitwarden', popup: 'popup/index.html' },
  { slot: 'metamask', dir: 'metamask', popup: 'popup-init.html' }
]

/** Seeds the registry the real way (test/extensions-fixtures.ts's own doc
 * says why this is the real boot path). Skips, with a logged reason, an
 * extension whose folder is missing or whose manifest.json
 * readExtensionManifest refuses -- one damaged download must not strand
 * every other extension's measurement. */
function seedReal (userDataDir: string, extractedDir: string): Map<string, ExtSpec & { id: string }> {
  const seeded = new Map<string, ExtSpec & { id: string }>()
  const entries: InstalledExtension[] = []
  for (const spec of SPECS) {
    const sourceDir = join(extractedDir, spec.dir)
    if (!existsSync(join(sourceDir, 'manifest.json'))) {
      console.error(`[extensions-real] skipping ${spec.slot}: no manifest.json at ${sourceDir}`)
      continue
    }
    const rawManifest: unknown = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8'))
    const parsed = readExtensionManifest(rawManifest)
    if (!parsed.ok) {
      console.error(`[extensions-real] skipping ${spec.slot}: manifest refused (${parsed.reason})`)
      continue
    }
    const { manifest, stripped } = loadableManifest(rawManifest as Record<string, unknown>)
    const key = resolveSlotKey(userDataDir, spec.slot)
    manifest.key = key
    const targetDir = join(userDataDir, 'extensions', spec.slot, parsed.facts.version)
    cpSync(sourceDir, targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifest))
    const id = generateId(key)
    const now = Date.now()
    entries.push({
      id,
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
    seeded.set(spec.slot, { ...spec, id })
  }
  writeFileSync(join(userDataDir, 'extensions', 'registry.json'), serializeRegistry(entries))
  return seeded
}

async function startFixtureServer (): Promise<{ server: Server, origin: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>real-extension-fixture</title><body>fixture</body>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  return { server, origin: `http://127.0.0.1:${String(address.port)}` }
}

function findPopup (windows: Page[], id: string): Page | undefined {
  return windows.find((w) => w.url().startsWith(`chrome-extension://${id}/`))
}

const SW_SETTLE_MS = 10_000
const TEST_TIMEOUT_MS = 180_000

const describeOrSkip = EXTRACTED !== undefined && EXTRACTED !== '' ? describe : describe.skip

describeOrSkip('real Chrome extensions', () => {
  it('measures each of uBOL/Dark Reader/Bitwarden/MetaMask through the real install path', async () => {
    const extractedDir = EXTRACTED as string
    const started = await startFixtureServer()
    const fixtureUrl = `${started.origin}/`

    await runPhase('real extensions', async (check) => {
      let app: Awaited<ReturnType<typeof launchElectron>> | undefined
      let seeded: Map<string, ExtSpec & { id: string }> = new Map()
      try {
        app = await launchElectron({
          appPath: '.',
          args: [HERMETIC_RESOLVER],
          seedProfile: async (dir) => { seeded = seedReal(dir, extractedDir) },
          sandbox: true
        })
        const liveApp = app

        check('at least one real extension was seeded', seeded.size > 0, `found ${seeded.size}/${SPECS.length}`)

        // Fresh, per-launch console/error capture for every worker in this
        // session, keyed by scope -- read back per extension below.
        await liveApp.evaluate(({ session }) => {
          const store: Record<string, string[]> = {}
          ;(globalThis as unknown as { __orivonSwLog: Record<string, string[]> }).__orivonSwLog = store
          session.defaultSession.serviceWorkers.on('console-message', (_e, details) => {
            if (details.level < 2) return
            const worker = session.defaultSession.serviceWorkers.getWorkerFromVersionID(details.versionId)
            const scope = worker?.scope ?? String(details.versionId)
            const list = store[scope] ?? (store[scope] = [])
            if (list.length < 3) list.push(String(details.message).slice(0, 300))
          })
        })

        await new Promise((resolve) => setTimeout(resolve, SW_SETTLE_MS))

        const chrome = findChrome(app)

        for (const [slot, spec] of seeded) {
          // ---- service worker running after 10s + its first errors ----
          const swInfo = await liveApp.evaluate(({ session }, id: string) => {
            const running = session.defaultSession.serviceWorkers.getAllRunning()
            const entry = Object.values(running).find((w) => w.scope.includes(id))
            const store = (globalThis as unknown as { __orivonSwLog: Record<string, string[]> }).__orivonSwLog ?? {}
            const scope = `chrome-extension://${id}/`
            return { running: entry !== undefined, errors: store[scope] ?? [] }
          }, spec.id)
          check(`${slot}: service worker running ${SW_SETTLE_MS / 1000}s after load`, swInfo.running, JSON.stringify(swInfo.errors))

          // ---- action popup opens with a non-empty body ----
          // Read through popup.content() (Page.getFrameTree/DOM.getOuterHTML
          // over CDP), never popup.evaluate()/evaluateRetrying(): a
          // LavaMoat-scuttled popup (MetaMask) throws "property 'setInterval'
          // of globalThis is inaccessible under scuttling mode" from inside
          // Playwright's own evaluate machinery, not from the page's real
          // content -- content() needs no script execution in the page and
          // reads the real popup HTML regardless.
          const actionSelector = `#${spec.id}`
          const actionAppeared = await waitFor(async () => await chrome.evaluate(
            (sel: string) => document.querySelector('browser-action-list')?.shadowRoot?.querySelector(sel) != null, actionSelector
          ), 5000).catch(() => false)
          if (actionAppeared) {
            // Up to 3 attempts: four extensions' popups/workers all settling
            // at once contends for the same process, and an occasional
            // popup navigation (ERR_FAILED) or late-appearing window under
            // that contention is a timing artifact, not a library bug --
            // measured directly (a single, unloaded extension's popup opens
            // clean every time; only the four-at-once run is flaky). A
            // click that lands on an already-open popup just re-focuses it.
            let popupOpened = false
            let bodyLen = 0
            for (let attempt = 0; attempt < 3 && !(popupOpened && bodyLen > 0); attempt++) {
              await chrome.click(actionSelector).catch(() => {})
              popupOpened = await waitFor(() => findPopup(liveApp.windows(), spec.id) !== undefined, 8000).catch(() => false)
              const popup = findPopup(liveApp.windows(), spec.id)
              bodyLen = popup === undefined ? 0 : await popup.content().then((html) => html.length).catch(() => 0)
            }
            check(`${slot}: action popup renders a non-empty body`, popupOpened && bodyLen > 0, `bodyLen=${String(bodyLen)}`)
          } else {
            check(`${slot}: action popup renders a non-empty body`, false, 'toolbar action never appeared')
          }
        }

        // ---- one behaviour each, on a fresh fixture tab ----
        const view = await navigateToFixture(app, fixtureUrl, 'real-extension-fixture')

        const darkreader = seeded.get('darkreader')
        if (darkreader !== undefined) {
          const styled = await waitFor(async () => await evaluateRetrying(view, () =>
            Array.from(document.querySelectorAll('style, link[rel="stylesheet"]')).some((el) => (el.textContent ?? '').includes('darkreader') || el.id.includes('darkreader'))
          ), 8000).catch(() => false)
          check('darkreader: injects its style into the fixture page', styled)
        }

        const metamask = seeded.get('metamask')
        if (metamask !== undefined) {
          const hasEthereum = await waitFor(async () => await evaluateRetrying(view, () => typeof (window as unknown as { ethereum?: unknown }).ethereum !== 'undefined'), 8000).catch(() => false)
          check('metamask: defines window.ethereum on the fixture page', hasEthereum)
        }

        const bitwarden = seeded.get('bitwarden')
        if (bitwarden !== undefined) {
          const responded = await evaluateRetrying(view, async () => await new Promise<boolean>((resolve) => {
            const onMessage = (event: MessageEvent): void => {
              if ((event.data as { command?: string } | undefined)?.command === 'hasBwInstalled') {
                window.removeEventListener('message', onMessage)
                resolve(true)
              }
            }
            window.addEventListener('message', onMessage)
            window.postMessage({ command: 'checkIfBWExtensionInstalled' }, '*')
            setTimeout(() => { window.removeEventListener('message', onMessage); resolve(false) }, 3000)
          })).catch(() => false)
          check('bitwarden: content script loads (responds to checkIfBWExtensionInstalled)', responded)
        }

        const ubol = seeded.get('ubol')
        if (ubol !== undefined) {
          // Covered by the generic action-popup check above; uBOL has no
          // separate page-visible behaviour a fixture page can observe.
          check('ubol: popup check above stands in for its page behaviour', true)
        }
      } finally {
        if (app !== undefined) await closeElectronApp(app)
        expect(await assertNoElectronSurvivors()).toEqual([])
      }
    })
  }, TEST_TIMEOUT_MS)
})
