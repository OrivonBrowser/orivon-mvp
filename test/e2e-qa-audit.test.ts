// The layout audit (qa-layout-audit.mjs) is only worth trusting if it is
// shown to fire. This serves one page with one deliberate defect per rule and
// one clean page, and asserts that every rule fires on the first and none on
// the second, so a green visual run cannot come from an audit that sees nothing.
//
// Run: node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-qa-audit.test.ts

import pngjs from 'pngjs'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runPhase } from './support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from './support/launch-electron.mjs'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit, type FixtureServer } from './support/qa-helpers.js'
import { auditLayout, applyAllowlist } from './support/qa-visual.js'

const { PNG } = pngjs

const BROKEN = `<!doctype html><meta charset="utf-8"><title>broken</title>
<style>
  body { margin: 0; font: 16px sans-serif }
  #wide { width: 3000px; height: 20px; background: #ddd }
  #clip { width: 60px; overflow: hidden; white-space: nowrap }
  #under, #cover { position: absolute; left: 20px; top: 200px; width: 120px; height: 40px }
  #cover { background: red }
  #ghost { width: 0; height: 0; padding: 0; border: 0; overflow: hidden }
  #dlg { position: absolute; left: 0; top: 300px; width: 200px; height: 80px; background: #eee }
</style>
<div id="wide">wide</div>
<div id="clip">this text is far too long for a sixty pixel wide box</div>
<button id="under">Under</button><div id="cover"></div>
<button id="ghost">Ghost</button>
<img src="/missing.png" alt="missing" width="20" height="20">
<svg id="empty" width="20" height="20"></svg>
<div id="dlg" role="dialog" aria-label="Off centre">Dialog</div>
<button id="mismatch" disabled aria-disabled="false">Mismatch</button>`

const CLEAN = `<!doctype html><meta charset="utf-8"><title>clean</title>
<style>
  body { margin: 0; font: 16px sans-serif; padding: 16px }
  .ellipsis { width: 60px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis }
  #dlg { position: fixed; left: 50%; top: 30%; transform: translateX(-50%); width: 300px; padding: 12px; background: #eee }
</style>
<h1>Clean page</h1>
<p class="ellipsis">a title that is cut with an ellipsis on purpose</p>
<a href="/next">A link</a> <button>Enabled</button> <button disabled aria-disabled="true">Disabled</button>
<input aria-label="Name" value="x">
<img src="/ok.png" alt="ok" width="20" height="20">
<svg width="20" height="20"><circle cx="10" cy="10" r="8"/></svg>
<div id="dlg" role="dialog" aria-label="Centred">Dialog</div>`

const OK_PNG = PNG.sync.write(new PNG({ width: 2, height: 2 }))
const EXPECTED_RULES = ['outside-viewport', 'clipped-text', 'overlapped-control', 'invisible-control', 'unexpected-scroll', 'broken-image', 'modal-placement', 'disabled-mismatch']

let server: FixtureServer
beforeAll(async () => {
  server = await startServer((req, res) => {
    if (req.url === '/broken') html(res, BROKEN)
    else if (req.url === '/clean') html(res, CLEAN)
    else if (req.url === '/ok.png') { res.setHeader('content-type', 'image/png'); res.end(OK_PNG) }
    else html(res, 'not found', 404)
  })
})
afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('fires every audit rule on a page broken on purpose, and none on a clean page', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('layout audit self-test', async (check) => {
      const broken = await visit(app, chrome, `${server.origin}/broken`)
      const found = await auditLayout(broken)
      const rules = new Set(found.findings.map((f) => f.rule))
      for (const rule of EXPECTED_RULES) {
        check(`fires ${rule} on the broken page`, rules.has(rule), `rules seen: ${[...rules].join(', ') || 'none'}`)
      }
      check('names the covering element for the overlapped button', found.findings.some((f) => f.rule === 'overlapped-control' && f.selector.includes('Under') && f.detail.includes('#cover')), JSON.stringify(found.findings.filter((f) => f.rule === 'overlapped-control')))

      check('catches an svg that renders nothing, separately from the missing image', found.findings.some((f) => f.rule === 'broken-image' && f.detail.includes('svg renders nothing')), JSON.stringify(found.findings.filter((f) => f.rule === 'broken-image')))

      const allowed = applyAllowlist(found.findings, [{ rule: 'modal-placement', reason: 'this dialog is off centre on purpose' }])
      check('an allowlisted rule moves to allowed, with its reason', allowed.findings.every((f) => f.rule !== 'modal-placement') && allowed.allowed.some((f) => f.rule === 'modal-placement' && f.reason !== ''))

      const clean = await visit(app, chrome, `${server.origin}/clean`)
      await clean.waitForFunction(() => Array.from(document.images).every((i) => i.complete))
      const quiet = await auditLayout(clean)
      check('reports nothing on the clean page', quiet.findings.length === 0, JSON.stringify(quiet.findings))
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
