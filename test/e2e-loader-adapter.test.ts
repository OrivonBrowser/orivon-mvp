// A141 (docs/open-questions.md): no test anywhere exercised the real
// electron-fetch.ts adapter -- every loader test injects a stub `Fetch`,
// and the stub's `response.url` disagreed with what real Electron's
// net.fetch actually reports (always '', A59/A141), with nothing to notice
// the disagreement. This file is what closes that: it drives the REAL
// `net.fetch`/`electronFetch` (./loader-adapter-entry.ts, bundled with
// esbuild and launched as a bare Electron main process -- see that file's
// own header) against a REAL local HTTP server, inside a REAL Electron
// process.
//
// NOT a full end-to-end `fetchBundle()` install: `electronFetch`'s own
// address guard (T12/A46) refuses every loopback literal outright, with no
// carve-out, so no server this process can stand up locally can ever pass
// it -- there is no way to reach a real `net.fetch` success THROUGH
// `electronFetch` without a genuinely public, routable HTTPS endpoint. What
// this file proves instead: (1) `electronFetch`'s guard really refuses a
// real local server, for real; (2) a real net.fetch Response's contract
// (ok/status/url/body/arrayBuffer) is exactly what fetch-budget.ts's real,
// unmodified `fetchWithBudget` needs, proven by draining real content
// through it; (3) `net.fetch`'s `response.url` really is '' on an ordinary
// response, matching the A59 spike's own measurement, as a standing
// regression check rather than a one-off probe; (4) `redirect: 'error'`
// really produces a rejection against a real redirecting server -- the
// guarantee electron-fetch.ts's own comment and fetch-budget.ts's `Fetch`
// doc comment both say this file proves.
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import esbuild from 'esbuild'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from './launch-electron.mjs'
import { waitFor } from './smoke-helpers.mjs'
import type { LoaderAdapterProbe } from './loader-adapter-entry.js'

const HOST = '127.0.0.1'
const PLAIN_BODY = 'orivon-loader-adapter-probe: hello'
const TEST_TIMEOUT_MS = 60_000

let server: Server
let port: number
let bundleDir: string
let bundlePath: string

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/plain' })
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(PLAIN_BODY) })
    res.end(PLAIN_BODY)
  })
  port = await new Promise<number>((resolve) => {
    server.listen(0, HOST, () => resolve((server.address() as { port: number }).port))
  })

  // esbuild is already present in node_modules (pulled in transitively by
  // vite, which this repo already depends on) but not declared in
  // package.json -- deliberately not added there for this PR, because this
  // worktree's node_modules is a symlink shared with a live parallel-fleet
  // run (docs/development/parallel-work.md), and `npm install` against a
  // shared tree while other lanes are mid-build is unsafe. See this PR's
  // body for the follow-up this leaves open.
  //
  // WHY A REAL BUNDLE, NOT esbuild's own TS-transpile-only mode: electron-
  // fetch.ts's own import graph (address.ts/address-ranges.ts/
  // address-parse.ts) is real, and this file's whole point is to exercise
  // the SHIPPED code, not a hand-copied reimplementation of it. `.cjs` as
  // the output extension makes the result CommonJS unconditionally,
  // regardless of any package.json `type` field -- no companion
  // package.json needed for the launched entry.
  bundleDir = await mkdtemp(join(tmpdir(), 'orivon-loader-adapter-'))
  bundlePath = join(bundleDir, 'entry.cjs')
  const entryPath = fileURLToPath(new URL('./loader-adapter-entry.ts', import.meta.url))
  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: bundlePath,
    external: ['electron'],
    logLevel: 'silent'
  })
}, 30_000)

afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve) => { server.close(() => resolve()) }),
    rm(bundleDir, { recursive: true, force: true })
  ])
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('the real electron-fetch.ts adapter, against a real local server, inside a real Electron process', async () => {
  const app = await launchElectron({ appPath: bundlePath })
  try {
    // app.whenReady() inside loader-adapter-entry.ts races independently of
    // launchElectron's own isReal check above -- wait for the hook it
    // installs rather than assuming it already ran.
    const hookInstalled = await waitFor(async () =>
      await app.evaluate(() => typeof globalThis.__orivonLoaderAdapterProbe !== 'undefined'), 10_000)
    expect(hookInstalled).toBe(true)

    const plainUrl = `http://${HOST}:${String(port)}/plain`
    const redirectUrl = `http://${HOST}:${String(port)}/redirect`

    // (1) electronFetch's own address guard refuses a REAL local server for
    // real -- T12/A46's no loopback carve-out, exercised end to end rather
    // than only against classifyAddress/isPublicUnicast in isolation.
    const guardResult = await app.evaluate(
      async (_electron, url: string) => await globalThis.__orivonLoaderAdapterProbe!.callElectronFetch(url, []),
      plainUrl
    )
    expect(guardResult.threw).toBe(true)
    expect(guardResult.errorMessage).toMatch(/not a public address literal/)

    // (2) & (3): net.fetch's real Response contract, against a real
    // ordinary response. response.url is '' (A59/A141, now a standing
    // regression check rather than a one-off spike result); type is
    // 'default', matching electron.d.ts's own documented limitation;
    // ok/status are what a genuine 200 OK looks like.
    const plainResult = await app.evaluate(
      async (_electron, url: string) => await globalThis.__orivonLoaderAdapterProbe!.callNetFetch(url),
      plainUrl
    )
    expect(plainResult.threw).toBe(false)
    expect(plainResult.ok).toBe(true)
    expect(plainResult.status).toBe(200)
    expect(plainResult.url).toBe('')
    expect(plainResult.type).toBe('default')

    // (2continued): the same real Response, fed through the REAL
    // fetchWithBudget (fetch-budget.ts, unmodified) -- proves the actual
    // byte-cap/streaming pipeline fetch-bundle.ts relies on drains a real
    // net.fetch body correctly, byte for byte.
    const budgetResult = await app.evaluate(
      async (_electron, args: { url: string, cap: number }) =>
        await globalThis.__orivonLoaderAdapterProbe!.callNetFetchThroughBudget(args.url, args.cap),
      { url: plainUrl, cap: 4096 }
    )
    expect(budgetResult.ok).toBe(true)
    expect(budgetResult.contentUtf8).toBe(PLAIN_BODY)

    // (4) THE LOAD-BEARING PROOF: redirect: 'error' really produces a
    // rejection against a real redirecting server. If this option is ever
    // removed or changed, this assertion fails -- see electron-fetch.ts's
    // own comment on `netFetch` and fetch-budget.ts's `Fetch` doc comment,
    // both of which point back here.
    const redirectResult = await app.evaluate(
      async (_electron, args: { url: string, cap: number }) =>
        await globalThis.__orivonLoaderAdapterProbe!.callNetFetchThroughBudget(args.url, args.cap),
      { url: redirectUrl, cap: 4096 }
    )
    expect(redirectResult.ok).toBe(false)
    expect(redirectResult.reason).toMatch(/could not fetch/)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
