// Visual QA for the real shell: a layout audit run inside each rendered view,
// a pixel baseline per named state, and a per-state record (screenshot plus
// JSON) written for a vision-capable reader. Specs call captureState() then
// checkState(); scripts/qa-report.mjs turns the records into inspect.md.
//
// What each part can and cannot prove is in docs/development/testing.md
// §Visual QA and failure evidence. Short version: the audit and the blank check
// are deterministic and always enforced; the pixel baseline is machine-local,
// so it is skipped when CI=true; the AI reading is never a substitute for
// either.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import pixelmatch from 'pixelmatch'
import pngjs from 'pngjs'
import type { ElectronApplication, Page } from 'playwright'
import { LATEST_DIR, errorsSince, mark, snapshotWindows, windowGeometry } from './qa-evidence.mjs'
import { mainOutput } from './launch-electron.mjs'
import { layoutAudit } from './qa-layout-audit.mjs'
import { findChrome, waitFor } from './smoke-helpers.mjs'

const { PNG } = pngjs

export interface LayoutFinding { rule: string, selector: string, detail: string }
/** One intended finding. `reason` is required: an exemption that costs
 * nothing stops meaning anything. `selector` matches as a substring. */
export interface AllowedFinding { rule: string, selector?: string, reason: string }
export interface Rect { x: number, y: number, width: number, height: number }
export type Check = (name: string, pass: boolean, detail?: string) => void

/** 0.005% of the window, about 50 pixels. Measured: an unchanged state differs by
 * 0.000%, and growing the tab titles from 12px to 13px moves 0.02% to 0.13%, so
 * anything looser misses a real change to the shell's small text. */
export const DEFAULT_MAX_DIFF_RATIO = 0.00005
export const STATES_DIR = join(LATEST_DIR, 'states')

const slug = (s: string): string => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80)

export function applyAllowlist (findings: LayoutFinding[], allow: AllowedFinding[] = []): { findings: LayoutFinding[], allowed: Array<LayoutFinding & { reason: string }> } {
  for (const a of allow) {
    if (a.reason.trim() === '') throw new Error(`Allowlisting ${a.rule} needs a reason: say why the finding is intended.`)
  }
  const kept: LayoutFinding[] = []
  const allowed: Array<LayoutFinding & { reason: string }> = []
  for (const f of findings) {
    const hit = allow.find((a) => a.rule === f.rule && (a.selector === undefined || f.selector.includes(a.selector)))
    if (hit === undefined) kept.push(f)
    else allowed.push({ ...f, reason: hit.reason })
  }
  return { findings: kept, allowed }
}

export async function auditLayout (page: Page, options: { verticalScroll?: 'allow' | 'forbid', allow?: AllowedFinding[] } = {}): Promise<ReturnType<typeof applyAllowlist>> {
  const raw = await page.evaluate(layoutAudit, { verticalScroll: options.verticalScroll ?? 'allow' })
  return applyAllowlist(raw, options.allow)
}

export function baselineDir (): string {
  const override = process.env['ORIVON_QA_BASELINES']
  if (override !== undefined && override !== '') return override
  return join(process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'), 'orivon-qa', 'baselines', process.platform)
}

function blankOut (img: InstanceType<typeof PNG>, rects: Rect[]): void {
  for (const r of rects) {
    for (let y = Math.max(0, r.y); y < Math.min(img.height, r.y + r.height); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(img.width, r.x + r.width); x++) {
        img.data.writeUInt32LE(0xff00ff, (y * img.width + x) * 4)
      }
    }
  }
}

export type PngDiff =
  | { sizeMismatch: true, expected: string, actual: string }
  | { sizeMismatch: false, diffPixels: number, ratio: number, diff: Buffer }

/** Anti-aliasing differences are ignored (pixelmatch's default); `ignore`
 * rectangles are painted the same colour in both images first. */
export function diffPngs (expected: Buffer, actual: Buffer, options: { ignore?: Rect[], threshold?: number } = {}): PngDiff {
  const a = PNG.sync.read(expected)
  const b = PNG.sync.read(actual)
  if (a.width !== b.width || a.height !== b.height) {
    return { sizeMismatch: true, expected: `${String(a.width)}x${String(a.height)}`, actual: `${String(b.width)}x${String(b.height)}` }
  }
  blankOut(a, options.ignore ?? [])
  blankOut(b, options.ignore ?? [])
  const out = new PNG({ width: a.width, height: a.height })
  const diffPixels = pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold: options.threshold ?? 0.1 })
  return { sizeMismatch: false, diffPixels, ratio: diffPixels / (a.width * a.height), diff: PNG.sync.write(out) }
}

/** Distinct colours among sampled pixels; a view that paints one or two is blank. */
export function distinctColours (png: Buffer, stride = 13): number {
  const img = PNG.sync.read(png)
  const seen = new Set<number>()
  for (let i = 0; i < img.data.length; i += 4 * stride) seen.add(img.data.readUInt32LE(i))
  return seen.size
}

export interface BaselineResult {
  status: 'recorded' | 'match' | 'mismatch' | 'size-mismatch' | 'skipped'
  ratio?: number
  maxDiffRatio: number
  baselinePath?: string
  diffPath?: string
  detail?: string
}

/**
 * Compares `png` with the machine-local baseline called `name`. No baseline,
 * or ORIVON_QA_UPDATE_BASELINES=1, records one. Only `npm run qa` and
 * `qa:visual` compare (ORIVON_QA_PIXELS=1), and never under CI=true: a baseline
 * is only meaningful on the machine and fonts that recorded it, so a plain
 * `test:e2e` must not fail on one.
 */
export async function compareBaseline (name: string, png: Buffer, options: { maxDiffRatio?: number, ignore?: Rect[], outDir?: string } = {}): Promise<BaselineResult> {
  const maxDiffRatio = options.maxDiffRatio ?? DEFAULT_MAX_DIFF_RATIO
  if (process.env['CI'] === 'true') return { status: 'skipped', maxDiffRatio, detail: 'CI=true: pixel baselines are machine-local' }
  if (process.env['ORIVON_QA_PIXELS'] !== '1') return { status: 'skipped', maxDiffRatio, detail: 'pixel comparison runs only under npm run qa or qa:visual' }
  const baselinePath = join(baselineDir(), `${slug(name)}.png`)
  const existing = await readFile(baselinePath).catch(() => undefined)
  if (existing === undefined || process.env['ORIVON_QA_UPDATE_BASELINES'] === '1') {
    await mkdir(baselineDir(), { recursive: true })
    await writeFile(baselinePath, png)
    return { status: 'recorded', maxDiffRatio, baselinePath }
  }
  const d = diffPngs(existing, png, { ignore: options.ignore ?? [] })
  if (d.sizeMismatch) return { status: 'size-mismatch', maxDiffRatio, baselinePath, detail: `baseline ${d.expected}, now ${d.actual}` }
  if (d.ratio <= maxDiffRatio) return { status: 'match', ratio: d.ratio, maxDiffRatio, baselinePath }
  const outDir = options.outDir ?? STATES_DIR
  await mkdir(outDir, { recursive: true })
  const diffPath = join(outDir, `${slug(name)}.diff.png`)
  await writeFile(diffPath, d.diff)
  await writeFile(join(outDir, `${slug(name)}.baseline.png`), existing)
  return { status: 'mismatch', ratio: d.ratio, maxDiffRatio, baselinePath, diffPath, detail: `${String(d.diffPixels)} pixels differ` }
}

/** Fixed content size, so a state looks the same on every run. */
export async function prepareWindow (app: ElectronApplication, size: { width: number, height: number } = { width: 1280, height: 800 }): Promise<void> {
  // The window re-asserts its initial bounds the moment it is shown (window-frame.ts's showOnce), which
  // undoes a resize made before that: wait until every window is visible, then resize.
  const shown = await waitFor(() => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().every((w) => w.isVisible())))
  if (!shown) throw new Error('the window was never shown, so its size cannot be set')
  await app.evaluate(({ BaseWindow }, s) => { for (const w of BaseWindow.getAllWindows()) w.setContentSize(s.width, s.height) }, size)
  const chrome = findChrome(app)
  const settled = await waitFor(async () => (await chrome.evaluate(() => window.innerWidth)) === size.width)
  if (!settled) throw new Error(`window did not settle at ${String(size.width)}px wide`)
}

const SETTLE_TIMEOUT_MS = 3_000

/** Fonts loaded and two frames painted: the readiness a screenshot needs,
 * never a sleep. Only for views the window shows: a hidden view (a background
 * tab) never paints a frame, so waiting on one would wait forever. */
async function settle (pages: Page[]): Promise<void> {
  await Promise.all(pages.map(async (p) => {
    const ready = p.evaluate(async () => {
      await document.fonts.ready
      await new Promise((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(resolve) }) })
    }).catch(() => undefined)
    let timer: NodeJS.Timeout | undefined
    await Promise.race([ready, new Promise((resolve) => { timer = setTimeout(resolve, SETTLE_TIMEOUT_MS) })])
    clearTimeout(timer)
  }))
}

export interface StateSpec {
  /** What a correct render of this state shows: the reader's yardstick. */
  expected: string
  /** What the test did to get here. */
  action: string
  /** Pages to audit. Default: every visible shell page (orivon-shell: and orivon:). */
  audit?: { pages?: Page[], verticalScroll?: 'allow' | 'forbid', allow?: AllowedFinding[] }
  ignore?: Rect[]
  allowBlank?: boolean
  maxDiffRatio?: number
  /** Where the pointer rests while capturing. Default 'idle': parked in empty tab-strip space, so no button shows its hover look. */
  pointer?: 'idle' | 'keep'
  /** Count http(s) page errors too. Default: shell pages only, since a fixture may misbehave on purpose. */
  includeContentErrors?: boolean
}

/** One shown shell view whose pre-paint colour disagrees with the colour its own page paints. */
export interface BackingFinding { url: string, recorded: string, page: string }

export interface StateReport {
  name: string
  expected: string
  action: string
  views: Array<{ url: string, title: string, shown: boolean }>
  audit: ReturnType<typeof applyAllowlist>
  /** Shown shell views whose recorded backing differs from the page's own root background, in this scheme. */
  backing: BackingFinding[]
  errors: Array<{ kind: string, url: string, text: string }>
  blank: boolean
  baseline: BaselineResult
  png: string | undefined
  ariaExcerpt: string
  mainLogTail: string
}

const asHex = (rgb: string): string | undefined => {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(rgb.trim())
  if (m === null || (m[4] !== undefined && Number(m[4]) === 0)) return undefined
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`
}

/**
 * The colour main paints behind each shown shell view before its page has, against the colour that page paints
 * (the root element's, else the body's). A mismatch is the frame a person sees between the two, in whichever
 * scheme the run is in. A page that paints no background of its own, and a view main records no colour for,
 * has nothing to compare and is left out, as is an address two views or pages share.
 */
export async function backingFindings (app: ElectronApplication, pages: Page[]): Promise<BackingFinding[]> {
  const recorded = await app.evaluate(({ BaseWindow }) => {
    const hook = (globalThis as unknown as { __orivonDevViewBackgrounds?: Map<number, string> }).__orivonDevViewBackgrounds
    const shown: Array<{ url: string, color: string | undefined }> = []
    const walk = (view: { children?: unknown[] }): void => {
      for (const child of (view.children ?? []) as Array<{ webContents?: { id: number, getURL: () => string }, getVisible?: () => boolean, children?: unknown[] }>) {
        if (child.webContents !== undefined && (child.getVisible?.() ?? true)) shown.push({ url: child.webContents.getURL(), color: hook?.get(child.webContents.id) })
        walk(child)
      }
    }
    for (const win of BaseWindow.getAllWindows()) walk(win.contentView as unknown as { children?: unknown[] })
    return shown
  })
  const found: BackingFinding[] = []
  for (const view of recorded) {
    // Views pair with pages by address: two views or two pages at one address could cross, so neither is compared.
    const sameAddress = pages.filter((p) => p.url() === view.url)
    const page = sameAddress[0]
    if (page === undefined || sameAddress.length > 1 || recorded.filter((v) => v.url === view.url).length > 1 || view.color === undefined || isContent(view.url)) continue
    // A page that paints a gradient (the internal pages) starts it in the colour main backs the view with: its first stop.
    const painted = await page.evaluate(() => [document.documentElement, document.body].flatMap((el) => {
      const style = getComputedStyle(el)
      return [style.backgroundColor, /rgba?\([^)]*\)/.exec(style.backgroundImage)?.[0] ?? '']
    })).catch(() => [])
    const pageColor = painted.map(asHex).find((c) => c !== undefined)
    if (pageColor !== undefined && pageColor !== view.color.toLowerCase()) found.push({ url: view.url, recorded: view.color.toLowerCase(), page: pageColor })
  }
  return found
}

const lastMark = new WeakMap<ElectronApplication, ReturnType<typeof mark>>()
const isContent = (url: string): boolean => /^https?:/.test(url)

/** Screenshots the whole window as it is now and records everything a reader needs to judge it. */
export async function captureState (app: ElectronApplication, name: string, spec: StateSpec): Promise<StateReport> {
  if (spec.pointer !== 'keep') {
    const chrome = findChrome(app)
    await chrome.mouse.move(Math.max(0, (await chrome.evaluate(() => window.innerWidth)) - 130), 8)
  }
  const shownUrls = (await windowGeometry(app)).flatMap((w) => w.views.filter((v) => v.visible).map((v) => v.url))
  const pages = app.windows()
  await settle(pages.filter((p) => shownUrls.includes(p.url())))
  const snap = await snapshotWindows(app, 6_000)

  const targets = spec.audit?.pages ?? pages.filter((p) => shownUrls.includes(p.url()) && !isContent(p.url()))
  const audit: ReturnType<typeof applyAllowlist> = { findings: [], allowed: [] }
  for (const page of targets) {
    const one = await auditLayout(page, { ...spec.audit })
    const tag = (f: LayoutFinding): LayoutFinding => ({ ...f, selector: `[${page.url().slice(-40)}] ${f.selector}` })
    audit.findings.push(...one.findings.map(tag))
    audit.allowed.push(...one.allowed.map((f) => ({ ...tag(f), reason: f.reason })))
  }

  const backing = await backingFindings(app, pages.filter((p) => shownUrls.includes(p.url())))

  const composite: Buffer | undefined = snap.composites[0]?.png
  const approximate = snap.composites[0]?.ambiguous === true
  const since = lastMark.get(app) ?? { console: 0, pageErrors: 0 }
  lastMark.set(app, mark(app))
  const errors = errorsSince(app, since).filter((e) => spec.includeContentErrors === true || !isContent(e.url))

  const blank = composite === undefined || distinctColours(composite) <= 2
  let baseline: BaselineResult = { status: 'skipped', maxDiffRatio: spec.maxDiffRatio ?? DEFAULT_MAX_DIFF_RATIO, detail: 'no window screenshot' }
  let png: string | undefined
  if (composite !== undefined) {
    await mkdir(STATES_DIR, { recursive: true })
    png = join(STATES_DIR, `${slug(name)}.png`)
    await writeFile(png, composite)
    if (approximate) baseline = { status: 'skipped', maxDiffRatio: spec.maxDiffRatio ?? DEFAULT_MAX_DIFF_RATIO, detail: 'two shown views could not be told apart, so the composite may pair them wrongly' }
    else baseline = await compareBaseline(name, composite, { ...(spec.maxDiffRatio === undefined ? {} : { maxDiffRatio: spec.maxDiffRatio }), ignore: spec.ignore ?? [] })
  }

  const ariaExcerpt = snap.views
    .filter((v) => v.png !== undefined && v.aria !== undefined)
    .map((v) => `## ${v.url}\n${(v.aria ?? '').slice(0, 3_000)}`).join('\n\n')
  const report: StateReport = {
    name,
    expected: spec.expected,
    action: spec.action,
    views: snap.views.map((v) => ({ url: v.url, title: v.title, shown: v.png !== undefined })),
    audit,
    backing,
    errors,
    blank: spec.allowBlank === true ? false : blank,
    baseline,
    png,
    ariaExcerpt,
    mainLogTail: mainOutput(app).slice(-1_500)
  }
  await mkdir(STATES_DIR, { recursive: true })
  await writeFile(join(STATES_DIR, `${slug(name)}.json`), JSON.stringify(report, null, 2) + '\n')
  return report
}

/** The deterministic verdicts on a captured state, as runPhase checks. */
export function checkState (check: Check, r: StateReport): void {
  const list = (xs: string[]): string | undefined => (xs.length === 0 ? undefined : xs.slice(0, 6).join('; '))
  check(`${r.name}: layout audit is clean`, r.audit.findings.length === 0, list(r.audit.findings.map((f) => `${f.rule} ${f.selector}: ${f.detail}`)))
  check(`${r.name}: each shown view's backing colour is the one its page paints`, r.backing.length === 0, list(r.backing.map((b) => `${b.url.slice(-50)} is backed ${b.recorded}, its page paints ${b.page}`)))
  check(`${r.name}: no shell console or page errors`, r.errors.length === 0, list(r.errors.map((e) => `${e.kind} ${e.url}: ${e.text.slice(0, 120)}`)))
  check(`${r.name}: the window painted something`, !r.blank, r.png === undefined ? 'no screenshot was produced' : 'screenshot is one flat colour')
  const b = r.baseline
  check(`${r.name}: matches its baseline (${b.status})`, b.status !== 'mismatch' && b.status !== 'size-mismatch',
    `${b.detail ?? ''}${b.ratio === undefined ? '' : ` (${(b.ratio * 100).toFixed(4)}% > ${(b.maxDiffRatio * 100).toFixed(4)}%)`} diff: ${b.diffPath ?? '-'}`)
}
