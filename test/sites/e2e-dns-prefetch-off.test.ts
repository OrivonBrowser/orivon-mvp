// A page's `<link rel="dns-prefetch">` must not make the engine look a name up on this computer: with the tunnel or a
// proxy in front, the name is for the far end to resolve. The engine logs every lookup it makes, speculative ones
// included, so the proof is the net log: a page that hints a name nothing else uses leaves no lookup for it.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from '../support/launch-electron.mjs'
import { html, QA_TEST_TIMEOUT_MS, startServer, visit } from '../support/qa-helpers.js'
import { findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const HINTED = 'prefetch-hint.localhost'
const CONTROL = 'plain-request.localhost'

interface NetLog { constants: { logEventTypes: Record<string, number> }, events: Array<{ type: number, params?: unknown }> }

it('does not look up a name a page only hints at', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orivon-dns-prefetch-'))
  const server = await startServer((req, res) => {
    if (req.url === '/favicon.ico') { res.statusCode = 404; res.end(); return }
    html(res, `<!doctype html><title>hints</title><link rel="dns-prefetch" href="//${HINTED}"><img src="http://${CONTROL}/pixel.png">`)
  })
  // Hermetic as every launch is, but `*.localhost` stays resolvable: the engine answers it itself, so the hinted name costs no packet and still reaches the resolver's log.
  const app = await launchElectron({ appPath: '.', args: [`${HERMETIC_RESOLVER}, EXCLUDE *.localhost`] })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)
    const path = join(dir, 'net.json')
    await app.evaluate(async ({ netLog }, target) => { await netLog.startLogging(target, { captureMode: 'includeSensitive' }) }, path)
    await visit(app, chrome, `${server.origin}/`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await app.evaluate(async ({ netLog }) => { await netLog.stopLogging() })

    const log = JSON.parse(await readFile(path, 'utf8')) as NetLog
    const names = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]))
    const lookups = (host: string): number => log.events.filter((event) => /HOST_RESOLVER/.test(names[event.type] ?? '') && JSON.stringify(event.params ?? {}).includes(host)).length
    // The control proves the log sees a lookup for a name the page does use, so an empty answer for the hint means something.
    expect(lookups(CONTROL), 'the log records the lookup of an image host').toBeGreaterThan(0)
    expect(lookups(HINTED), 'a lookup for the hinted name').toBe(0)
  } finally {
    await closeElectron(app)
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
}, QA_TEST_TIMEOUT_MS)
