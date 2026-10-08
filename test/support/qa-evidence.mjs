// Failure evidence for the e2e suite: what each launched app logged, and what
// its windows looked like, kept in memory until a test is known to have failed.
//
// launch-electron.mjs calls attachCollectors() at launch and holdEvidence()
// at close, because a spec closes its app in `finally`, before Vitest knows
// the result. qa-setup.ts decides in afterEach whether to write the held
// bundles (failure) or drop them (pass). Nothing here may throw into a launch
// or a teardown: every Playwright call is time-boxed and its error recorded.
// docs/development/testing.md section Visual QA and failure evidence has the layout.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pngjs from 'pngjs'

const { PNG } = pngjs

/** `qa-artifacts/` at the repository root (gitignored). */
export const QA_ROOT = fileURLToPath(new URL('../../qa-artifacts/', import.meta.url))
export const LATEST_DIR = join(QA_ROOT, 'latest')

const LIST_CAP = 500
const SNAPSHOT_BUDGET_MS = 3_000
const HELD_CAP = 8
const ORPHAN_SHOT_MS = 600
const HOLD_BUDGET_MS = 3_500
const DOM_CAP_BYTES = 200_000

/** @typedef {{ url: string, title: string, png: Buffer | undefined, aria: string | undefined, html: string | undefined, cornerRadius: number, errors: string[] }} ViewSnapshot */
/** @typedef {{ url: string, bounds: { x: number, y: number, width: number, height: number }, visible: boolean }} ViewGeometry */
/** @typedef {{ width: number, height: number, views: ViewGeometry[] }} WindowGeometry */
/** @typedef {{ views: ViewSnapshot[], composites: Array<{ width: number, height: number, png: Buffer, ambiguous: boolean }>, geometry: WindowGeometry[], errors: string[] }} WindowSnapshot */

const COLLECTORS = new WeakMap()
/** Apps with collectors that have not been closed yet. */
const LIVE = new Set()
/** Bundles taken at close, waiting for the test's verdict. */
let held = []

/** On under Vitest, where qa-setup.ts decides what to write; off for a plain
 * script (smoke) that has nothing to write it, unless ORIVON_QA_EVIDENCE=on. */
export const evidenceEnabled = () => {
  const setting = process.env['ORIVON_QA_EVIDENCE']
  return setting !== 'off' && (setting === 'on' || process.env['VITEST'] !== undefined)
}

/** Capped lists shift their oldest entry out, so a position in one is not a
 * stable mark: each entry of a list that mark() reads carries a running `n`. */
function push (list, item, counters, key) {
  if (counters !== undefined) item.n = counters[key] = (counters[key] ?? 0) + 1
  list.push(item)
  if (list.length > LIST_CAP) list.shift()
}

const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'x'

async function within (promise, ms, fallback) {
  let timer
  try {
    return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms, fallback) })])
  } catch {
    return fallback
  } finally {
    clearTimeout(timer)
  }
}

/** Starts recording `app`'s console warnings and errors, page errors, failed
 * requests, page crashes and main-process events. Safe on a fake app.
 * `mainLog` reads the app's own output, for a bundle taken while it still runs.
 * @param {any} app
 * @param {{ mainLog?: () => string }} [options] */
export function attachCollectors (app, { mainLog = () => '' } = {}) {
  if (!evidenceEnabled() || typeof app?.on !== 'function' || typeof app.windows !== 'function') return
  const c = { console: [], pageErrors: [], failedRequests: [], crashes: [], seq: { console: 0, pageErrors: 0 }, mainLog, traceZip: undefined }
  COLLECTORS.set(app, c)
  LIVE.add(app)

  const hook = (page) => {
    const at = () => { try { return page.url() } catch { return '' } }
    page.on('console', (m) => {
      const type = m.type()
      if (type === 'error' || type === 'warning') {
        push(c.console, { t: Date.now(), type, text: m.text().slice(0, 2000), url: at(), location: m.location() }, c.seq, 'console')
      }
    })
    page.on('pageerror', (e) => {
      push(c.pageErrors, { t: Date.now(), url: at(), message: String(e?.message ?? e).slice(0, 2000), stack: String(e?.stack ?? '').slice(0, 4000) }, c.seq, 'pageErrors')
    })
    page.on('requestfailed', (r) => {
      push(c.failedRequests, { t: Date.now(), url: r.url(), method: r.method(), failure: r.failure()?.errorText ?? '', page: at() })
    })
    page.on('crash', () => push(c.crashes, { t: Date.now(), url: at() }))
  }
  for (const page of app.windows()) hook(page)
  app.on('window', hook)

  // uncaughtExceptionMonitor, not uncaughtException: a plain listener would
  // suppress Electron's own error dialog and change what the test observes.
  // There is no monitor for unhandled rejections; main.log carries those.
  void app.evaluate(({ app: electronApp }) => {
    const g = globalThis
    if (g.__orivonQaEvents !== undefined) return
    const events = g.__orivonQaEvents = []
    const add = (kind, detail) => { if (events.length < 200) events.push({ t: Date.now(), kind, detail }) }
    process.on('uncaughtExceptionMonitor', (err, origin) => add('uncaughtException', { message: String(err?.stack ?? err), origin }))
    electronApp.on('render-process-gone', (_e, wc, details) => {
      let url = ''
      try { url = wc.getURL() } catch { /* destroyed */ }
      add('render-process-gone', { url, ...details })
    })
    electronApp.on('child-process-gone', (_e, details) => add('child-process-gone', details))
  }).catch(() => {})

  if (process.env['ORIVON_QA_TRACE'] === '1') {
    void app.context().tracing.start({ screenshots: true, snapshots: true }).catch(() => {})
  }
}

/** How many console and page-error entries have been recorded so far; pass to errorsSince(). */
export function mark (app) {
  const c = COLLECTORS.get(app)
  return { console: c?.seq.console ?? 0, pageErrors: c?.seq.pageErrors ?? 0 }
}

/** Console errors (not warnings) and page errors recorded after `since`. */
export function errorsSince (app, since) {
  const c = COLLECTORS.get(app)
  if (c === undefined) return []
  return [
    ...c.console.filter((e) => e.n > since.console && e.type === 'error').map((e) => ({ kind: 'console.error', url: e.url, text: e.text })),
    ...c.pageErrors.filter((e) => e.n > since.pageErrors).map((e) => ({ kind: 'pageerror', url: e.url, text: e.message }))
  ]
}

/** A copy of everything collected for `app` so far; undefined for an app with no collectors. */
export function collected (app) {
  const c = COLLECTORS.get(app)
  return c === undefined ? undefined : { console: [...c.console], pageErrors: [...c.pageErrors], failedRequests: [...c.failedRequests], crashes: [...c.crashes] }
}

export const liveApps = () => [...LIVE]

function redactDom () {
  const doc = document.documentElement.cloneNode(true)
  for (const el of doc.querySelectorAll('input[type=password]')) el.removeAttribute('value')
  for (const el of doc.querySelectorAll('script')) el.textContent = ''
  return doc.outerHTML
}

const safeUrl = (page) => { try { return page.url() } catch { return '' } }

/** @returns {Promise<ViewSnapshot>} */
async function snapPage (page, timeout, shotTimeout) {
  /** @type {ViewSnapshot} */
  const out = { url: '', title: '', png: undefined, aria: undefined, html: undefined, cornerRadius: 0, errors: [] }
  try { out.url = page.url() } catch { /* closed */ }
  const step = async (name, run) => {
    try { return await run() } catch (e) { out.errors.push(`${name}: ${String(e?.message ?? e).split('\n')[0]}`); return undefined }
  }
  out.title = (await step('title', () => page.title(timeout))) ?? ''
  if (shotTimeout > 0) out.png = await step('screenshot', () => page.screenshot({ timeout: shotTimeout, animations: 'disabled', caret: 'hide' }))
  else out.errors.push('screenshot: skipped, not a visible view')
  out.aria = await step('aria', () => page.ariaSnapshot({ timeout }))
  out.cornerRadius = (await step('radius', () => page.evaluate(cardRadius))) ?? 0
  const html = await step('dom', () => page.evaluate(redactDom))
  out.html = html === undefined ? undefined : html.slice(0, DOM_CAP_BYTES)
  return out
}

/** The corner radius an overlay page draws its card with, which is the radius main clips the view to; 0 for any other page. Runs in the page. */
function cardRadius () {
  if (document.body?.dataset?.surface === undefined) return 0
  const radius = Number.parseFloat(getComputedStyle(document.body, '::after').borderTopLeftRadius)
  return Number.isFinite(radius) ? Math.max(0, Math.min(radius, 40)) : 0
}

/** Puts back what lay under the corners a rounded view's clip cuts away: a page screenshot is the whole rectangle, the window shows only the rounded part. */
function restoreCorners (canvas, before, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2)
  for (let dy = 0; dy < r; dy++) {
    for (let dx = 0; dx < r; dx++) {
      if (Math.hypot(r - dx - 0.5, r - dy - 0.5) <= r) continue
      for (const [px, py] of [[dx, dy], [width - 1 - dx, dy], [dx, height - 1 - dy], [width - 1 - dx, height - 1 - dy]]) {
        const at = ((y + py) * canvas.width + x + px) * 4
        if (x + px < 0 || x + px >= canvas.width || y + py < 0 || y + py >= canvas.height) continue
        before.copy(canvas.data, at, at, at + 4)
      }
    }
  }
}

/** @returns {Promise<WindowGeometry[]>} */
export async function windowGeometry (app) {
  return await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().map((win) => {
    const views = []
    const walk = (view, ox, oy) => {
      for (const child of view.children ?? []) {
        const b = child.getBounds()
        if (child.webContents !== undefined) {
          views.push({ url: child.webContents.getURL(), bounds: { x: ox + b.x, y: oy + b.y, width: b.width, height: b.height }, visible: child.getVisible?.() ?? true })
        }
        walk(child, ox + b.x, oy + b.y)
      }
    }
    walk(win.contentView, 0, 0)
    const c = win.getContentBounds()
    return { width: c.width, height: c.height, views }
  }))
}

/** One PNG per window, views drawn in z-order at their bounds. Views are
 * matched to pages by URL, then by size, so two tabs on one URL can swap: the
 * per-view PNGs are the ground truth and this one is for a quick look. */
function compose (geometry, snaps) {
  const pool = snaps.filter((s) => s.png !== undefined).map((s) => ({ snap: s, image: undefined }))
  const decoded = (entry) => { entry.image ??= PNG.sync.read(entry.snap.png); return entry.image }
  return geometry.map((win) => {
    const canvas = new PNG({ width: Math.max(1, win.width), height: Math.max(1, win.height) })
    canvas.data.fill(0x80)
    const shown = win.views.filter((v) => v.visible)
    // Two shown views on one URL cannot be told apart by URL, and two candidates
    // of one size cannot be told apart by size: the pairing may then be swapped.
    let ambiguous = shown.some((v, i) => shown.findIndex((o) => o.url === v.url) !== i)
    for (const view of shown) {
      const sizeOf = (e) => { try { return decoded(e).width === view.bounds.width && decoded(e).height === view.bounds.height } catch { return false } }
      const byUrl = pool.findIndex((e) => e.snap.url === view.url)
      let i = byUrl
      if (i < 0) {
        const candidates = pool.filter(sizeOf)
        if (candidates.length > 1) ambiguous = true
        i = candidates.length === 0 ? -1 : pool.indexOf(candidates[0])
      }
      if (i < 0) continue
      const entry = pool.splice(i, 1)[0]
      try {
        const src = decoded(entry)
        const before = entry.snap.cornerRadius > 0 ? Buffer.from(canvas.data) : undefined
        PNG.bitblt(src, canvas, 0, 0, Math.min(src.width, view.bounds.width), Math.min(src.height, view.bounds.height), Math.max(0, view.bounds.x), Math.max(0, view.bounds.y))
        if (before !== undefined) restoreCorners(canvas, before, view.bounds.x, view.bounds.y, Math.min(src.width, view.bounds.width), Math.min(src.height, view.bounds.height), entry.snap.cornerRadius)
      } catch { /* undecodable view: leave the gap visible */ }
    }
    return { width: win.width, height: win.height, png: PNG.sync.write(canvas), ambiguous }
  })
}

/** Screenshot, ARIA tree and redacted DOM of every page of a live app, plus a
 * composite per window. Bounded by `budgetMs`; never throws. */
/** @returns {Promise<WindowSnapshot>} */
export async function snapshotWindows (app, budgetMs = SNAPSHOT_BUDGET_MS) {
  /** @type {WindowSnapshot} */
  const result = { views: [], composites: [], geometry: [], errors: [] }
  try {
    result.geometry = (await within(windowGeometry(app), 1_000, [])) ?? []
    // page.screenshot() on a hidden view (a background tab) hangs until its
    // timeout, which would add seconds to every close. Only pages that match a
    // visible view by URL are shot with the full budget. A visible view no page
    // matches (an error page: the view reports the failed URL, the page reports
    // chrome-error://) sends the other pages through a short attempt instead;
    // hidden ones time out there, and compose() pairs the survivors by size.
    // With no geometry at all, every page is tried.
    const visible = result.geometry.flatMap((w) => w.views.filter((v) => v.visible).map((v) => v.url))
    const pages = app.windows()
    const matched = pages.map((p) => {
      const i = visible.indexOf(p.url())
      if (i >= 0) visible.splice(i, 1)
      return i >= 0
    })
    const perPage = Math.max(500, budgetMs - 1_000)
    const shot = (isMatched) => (result.geometry.length === 0 || isMatched ? perPage : visible.length > 0 ? ORPHAN_SHOT_MS : 0)
    // Per page, so one hung or crashed page cannot cost the others their evidence.
    result.views = await Promise.all(pages.map((p, i) => within(snapPage(p, perPage, shot(matched[i])), budgetMs,
      { url: safeUrl(p), title: '', png: undefined, aria: undefined, html: undefined, errors: [`snapshot: no answer within ${String(budgetMs)}ms`] })))
    result.composites = compose(result.geometry, result.views)
  } catch (e) {
    result.errors.push(String(e?.message ?? e))
  }
  return result
}

async function stopTrace (app, c) {
  if (process.env['ORIVON_QA_TRACE'] !== '1' || c.traceZip !== undefined) return
  const path = join(tmpdir(), `orivon-qa-trace-${String(process.pid)}-${String(Date.now())}.zip`)
  await within(app.context().tracing.stop({ path }), 3_000, undefined)
  c.traceZip = path
}

function bundleOf (c, snap, mainEvents, mainLog) {
  return {
    snap,
    mainEvents,
    mainLog,
    console: [...c.console],
    pageErrors: [...c.pageErrors],
    failedRequests: [...c.failedRequests],
    crashes: [...c.crashes],
    traceZip: c.traceZip
  }
}

const noSnapshot = (reason) => ({ views: [], composites: [], geometry: [], errors: [reason] })

/** Everything known about `app` right now, as a bundle writeEvidenceBundle() can write.
 * `mainLog` defaults to the launcher's own capture of the app's output.
 * @param {any} app
 * @param {{ mainLog?: string, alive?: boolean }} [options] */
export async function bundleFor (app, { mainLog, alive = true } = {}) {
  const c = COLLECTORS.get(app)
  if (c === undefined) return undefined
  const log = mainLog ?? c.mainLog()
  if (!alive) return bundleOf(c, noSnapshot('app already exited'), [], log)
  const snap = await snapshotWindows(app)
  const mainEvents = (await within(app.evaluate(() => globalThis.__orivonQaEvents ?? []), 1_000, [])) ?? []
  await stopTrace(app, c)
  return bundleOf(c, snap, mainEvents, log)
}

/** Called by closeElectron(): keeps the app's final state until the verdict.
 * Bounded as a whole, because a hung app is exactly when closeElectron runs.
 * @param {any} app
 * @param {{ mainLog?: string, alive?: boolean }} [options] */
export async function holdEvidence (app, options = {}) {
  if (!LIVE.has(app)) return
  LIVE.delete(app)
  const c = COLLECTORS.get(app)
  try {
    const bundle = await within(bundleFor(app, options), HOLD_BUDGET_MS,
      bundleOf(c, noSnapshot(`no snapshot within ${String(HOLD_BUDGET_MS)}ms`), [], options.mainLog ?? c.mainLog()))
    held.push(bundle)
    for (const dropped of held.splice(0, Math.max(0, held.length - HELD_CAP))) await dropBundle(dropped)
  } catch (e) {
    console.error('[qa-evidence] could not hold evidence:', e)
  }
}

async function dropBundle (bundle) {
  if (bundle.traceZip !== undefined) await rm(bundle.traceZip, { force: true }).catch(() => {})
}

export async function dropHeld () {
  const dropped = held
  held = []
  for (const bundle of dropped) await dropBundle(bundle)
}

const json = (value) => JSON.stringify(value, null, 2) + '\n'

/** Writes one bundle under `dir`; returns the relative file list. */
export async function writeEvidenceBundle (dir, bundle) {
  const files = []
  const put = async (rel, data) => {
    const path = join(dir, rel)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, data)
    files.push(rel)
  }
  const { snap } = bundle
  for (const [i, v] of snap.views.entries()) {
    const name = `${String(i)}-${slug(v.url)}`
    if (v.png !== undefined) await put(`screenshots/${name}.png`, v.png)
    if (v.aria !== undefined) await put(`aria/${name}.txt`, v.aria)
    if (v.html !== undefined) await put(`dom/${name}.html`, v.html)
  }
  for (const [i, comp] of snap.composites.entries()) await put(`screenshots/window-${String(i)}-composite.png`, comp.png)
  await put('views.json', json(snap.views.map((v) => ({ url: v.url, title: v.title, errors: v.errors }))))
  await put('window-geometry.json', json(snap.geometry))
  await put('console.json', json(bundle.console))
  await put('page-errors.json', json(bundle.pageErrors))
  await put('failed-requests.json', json(bundle.failedRequests))
  await put('crashes.json', json(bundle.crashes))
  await put('main-events.json', json(bundle.mainEvents))
  await put('main.log', bundle.mainLog)
  if (bundle.traceZip !== undefined) {
    const zip = await readFile(bundle.traceZip).catch(() => undefined)
    if (zip !== undefined) await put('trace.zip', zip)
  }
  return files
}

/**
 * Called by qa-setup.ts when a test failed: writes every held bundle and a
 * fresh snapshot of any app still running, then links the folder from
 * qa-artifacts/latest/index.md.
 */
export async function writeFailureEvidence ({ file, name, error, retried }) {
  const bundles = held
  held = []
  for (const app of liveApps()) {
    const bundle = await bundleFor(app, { alive: true }).catch(() => undefined)
    if (bundle !== undefined) bundles.push(bundle)
  }
  const rel = join(slug(file), slug(name))
  const dir = join(LATEST_DIR, rel)
  const lines = [`# ${name}`, '', `File: ${file}`, retried ? '**RETRIED: this test needed a retry to reach this state.**' : '', '', '## Error', '', '```', String(error ?? 'unknown').slice(0, 6000), '```', '']
  for (const [i, bundle] of bundles.entries()) {
    const launch = `launch-${String(i + 1)}`
    const files = await writeEvidenceBundle(join(dir, launch), bundle)
    lines.push(`## ${launch}`, '',
      `- pages: ${String(bundle.snap.views.length)}, console errors/warnings: ${String(bundle.console.length)}, page errors: ${String(bundle.pageErrors.length)}, failed requests: ${String(bundle.failedRequests.length)}, crashes: ${String(bundle.crashes.length)}, main events: ${String(bundle.mainEvents.length)}`,
      ...files.map((f) => `- ${launch}/${f}`), '')
    await dropBundle(bundle)
  }
  if (bundles.length === 0) lines.push('No launched app was active in this test; nothing to snapshot.', '')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'summary.md'), lines.join('\n'))
  const first = String(error ?? '').split('\n')[0]?.slice(0, 160) ?? ''
  await writeFile(join(LATEST_DIR, 'index.md'), `- [${name}](${rel}/summary.md): ${first}\n`, { flag: 'a' })
  return dir
}
