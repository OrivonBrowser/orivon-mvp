// Standalone Electron main-process entry for ./e2e-loader-adapter.test.ts --
// never launched directly (see .claude/skills/orivon-electron/SKILL.md).
// That test bundles this file with esbuild and launches the result exactly
// like any other e2e fixture (test/launch-electron.mjs's launchElectron()),
// then drives the hook below through app.evaluate(). Opens no window --
// nothing here needs one, and Electron does not exit for lack of one; the
// test's own closeElectron() call ends this process.
//
// Exists because of A141 (docs/open-questions.md): no test anywhere
// exercised the real electron/fetch.ts adapter before this -- every loader
// test injects a stub `Fetch`. This is what lets a test reach the REAL
// `net.fetch` and `electronFetch`, against a REAL local server, from a REAL
// Electron main process.

import { app } from 'electron'
import { electronFetch, netFetch } from '../src/loader/electron/fetch.js'
import { electronResolveHost } from '../src/loader/electron/resolve.js'
import { ByteBudget, fetchWithBudget } from '../src/loader/fetch/budget.js'
import type { Fetch, FetchResponse } from '../src/loader/fetch/budget.js'

/** What a real Response carries beyond FetchResponse's minimal structural
 * shape -- read here only for this probe's own reporting; production code
 * never reads either field (electron.d.ts documents both as unreliable). */
interface RealFetchResponse extends FetchResponse {
  readonly type: string
  readonly redirected: boolean
}

export interface NetFetchProbeResult {
  readonly threw: boolean
  readonly errorMessage?: string
  readonly ok?: boolean
  readonly status?: number
  readonly url?: string
  readonly type?: string
  readonly redirected?: boolean
}

export interface BudgetProbeResult {
  readonly ok: boolean
  readonly reason?: string
  readonly contentUtf8?: string
}

export interface ResolveHostProbeResult {
  readonly threw: boolean
  readonly errorMessage?: string
  readonly addresses?: readonly string[]
}

export interface LoaderAdapterProbe {
  callElectronFetch: (url: string, pinnedAddresses: readonly string[]) => Promise<NetFetchProbeResult>
  callNetFetch: (url: string) => Promise<NetFetchProbeResult>
  callNetFetchThroughBudget: (url: string, assetCap: number) => Promise<BudgetProbeResult>
  callResolveHost: (host: string) => Promise<ResolveHostProbeResult>
}

declare global {
  // `var`, not `let`/`const`: TypeScript requires it for a `declare global`
  // augmentation (same convention as src/main/dev-grant.ts's own hook).
  var __orivonLoaderAdapterProbe: LoaderAdapterProbe | undefined
}

function summarize (response: FetchResponse): NetFetchProbeResult {
  const real = response as RealFetchResponse
  return { threw: false, ok: real.ok, status: real.status, url: real.url, type: real.type, redirected: real.redirected }
}

/** `electronFetch`, including its address guard -- the only real call this
 * probe can make that exercises that guard for real. It refuses every
 * loopback literal outright (T12/A46's no carve-out), so this can only ever
 * observe the guard's own rejection against a local server, never the
 * fetch beyond it -- see `callNetFetch` for that half. */
async function callElectronFetch (url: string, pinnedAddresses: readonly string[]): Promise<NetFetchProbeResult> {
  const controller = new AbortController()
  try {
    return summarize(await electronFetch(url, pinnedAddresses, controller.signal))
  } catch (error) {
    return { threw: true, errorMessage: error instanceof Error ? error.message : String(error) }
  }
}

/** `netFetch` directly -- electronFetch's own guard-free primitive (the
 * exact net.fetch call electronFetch makes once its guard has passed).
 * Reports the real Response's own contract: what fetch/bundle.ts and
 * fetch/budget.ts actually read, plus `.type`/`.url` for the A59/A141
 * regression check. */
async function callNetFetch (url: string): Promise<NetFetchProbeResult> {
  const controller = new AbortController()
  try {
    return summarize(await netFetch(url, controller.signal))
  } catch (error) {
    return { threw: true, errorMessage: error instanceof Error ? error.message : String(error) }
  }
}

/** Feeds a `netFetch`-backed `Fetch` through the REAL, unmodified
 * `fetchWithBudget` -- proves the byte-cap/streaming pipeline fetch/bundle.ts
 * actually relies on works against a real net.fetch Response, and (pointed
 * at a redirecting url) proves `redirect: 'error'` really produces a
 * rejection here, not just in electron/fetch.ts's own comment. */
async function callNetFetchThroughBudget (url: string, assetCap: number): Promise<BudgetProbeResult> {
  const controller = new AbortController()
  const fetchFn: Fetch = async (target, _pinnedAddresses, signal) => await netFetch(target, signal)
  const chunks: Uint8Array[] = []
  const result = await fetchWithBudget(fetchFn, url, [], assetCap, new ByteBudget(assetCap), 'probe', controller.signal, async (chunk) => { chunks.push(chunk) })
  if ('ok' in result) return { ok: false, reason: result.reason }
  const decoder = new TextDecoder('utf-8', { fatal: false })
  return { ok: true, contentUtf8: chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode() }
}

/** `electronResolveHost` directly -- A141's own gap, left open for this
 * adapter's resolver half (Finding 2): every existing test injects a fake
 * `Resolver`, so nothing here proved `net.resolveHost`'s real
 * `endpoints[].address` shape actually maps the way electron/resolve.ts
 * assumes, or what it does when Chromium's own resolver has no answer. */
async function callResolveHost (host: string): Promise<ResolveHostProbeResult> {
  try {
    return { threw: false, addresses: await electronResolveHost(host) }
  } catch (error) {
    return { threw: true, errorMessage: error instanceof Error ? error.message : String(error) }
  }
}

void app.whenReady().then(() => {
  globalThis.__orivonLoaderAdapterProbe = { callElectronFetch, callNetFetch, callNetFetchThroughBudget, callResolveHost }
})
