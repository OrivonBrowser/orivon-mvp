// The page tools in the running shell: Save page as, Save as PDF, View page source, Take a
// screenshot, Print and Picture in picture, from the keyboard and from the main menu, with every
// dialog replaced and every file written into a temp directory, and a PDF opening in an ordinary
// tab. Set ORIVON_UI_SHOTS_DIR to also write screenshots of the new surfaces in both colour schemes.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { pointScript } from '../src/main/page-tools/pip.js'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './support/launch-electron.mjs'
import { clickAddressBarRetrying, pressKey } from './support/e2e-helpers.js'
import { ABSENCE_SETTLE_MS, delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, popoverShown, tabIds, waitFor, waitForTab } from './support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 90_000
const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const MARKER = 'PAGE_TOOLS_MARKER_7f3a'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')

/** A one-page PDF with correct offsets, so the viewer has nothing to repair. */
function pdfBytes (): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length 44 >>\nstream\nBT /F1 24 Tf 20 100 Td (PDF) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => { offsets.push(out.length); out += `${String(index + 1)} 0 obj\n${body}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const PAGE = `<!doctype html><title>Fixture: page tools</title>
<body style="margin:0"><h1>${MARKER}</h1>
<video id="v" muted autoplay playsinline width="320" height="180"></video>
<div style="height:3000px;background:linear-gradient(#fff,#cde)"></div>
<script>
const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
const ctx = canvas.getContext('2d'); let n = 0
setInterval(() => { ctx.fillStyle = 'hsl(' + (n++ * 7 % 360) + ',70%,50%)'; ctx.fillRect(0, 0, 320, 180) }, 60)
const v = document.getElementById('v'); v.srcObject = canvas.captureStream(15); v.play().catch(() => {})
</script></body>`

// The video sits in the shadow root of the page's own element, which the document sees only as the element.
const SHADOW_PAGE = `<!doctype html><title>Fixture: shadow video</title><body style="margin:0"><video-card></video-card>
<script>
customElements.define('video-card', class extends HTMLElement {
  connectedCallback () {
    const root = this.attachShadow({ mode: 'open' })
    root.innerHTML = '<video id="v" muted autoplay playsinline width="320" height="180" style="display:block"></video>'
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
    const ctx = canvas.getContext('2d'); let n = 0
    setInterval(() => { ctx.fillStyle = 'hsl(' + (n++ * 7 % 360) + ',70%,50%)'; ctx.fillRect(0, 0, 320, 180) }, 60)
    const v = root.getElementById('v'); v.srcObject = canvas.captureStream(15); v.play().catch(() => {})
  }
})
</script></body>`

let server: Server
let origin = ''
let outDir = ''

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'orivon-page-tools-'))
  server = createServer((request, response) => {
    const url = request.url ?? '/'
    if (url === '/doc.pdf') { response.setHeader('content-type', 'application/pdf'); response.end(pdfBytes()); return }
    if (url === '/pic.png') { response.setHeader('content-type', 'image/png'); response.end(PNG); return }
    if (url === '/shadow') { response.setHeader('content-type', 'text/html'); response.end(SHADOW_PAGE); return }
    if (url === '/novideo') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>No video</title><p>text only</p>'); return }
    response.setHeader('content-type', 'text/html')
    response.end(PAGE)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  rmSync(outDir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

async function launched (address: string): Promise<{ app: App, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  const chrome = findChrome(app)
  await visit(chrome, address)
  return { app, chrome }
}

async function visit (chrome: Page, address: string): Promise<void> {
  await clickAddressBarRetrying(chrome, address)
  expect((await waitForTab(chrome, { address })).ok).toBe(true)
}

/** The next save dialog answers `path`, or is cancelled when it is null; every set of options it was shown is kept. */
async function stubSaveDialog (app: App, path: string | null): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    const g = globalThis as unknown as { __saveOptions: unknown[] }
    g.__saveOptions = []
    ;(dialog as unknown as { showSaveDialog: (...args: unknown[]) => Promise<unknown> }).showSaveDialog = async (...args: unknown[]) => {
      g.__saveOptions.push(args[args.length - 1])
      return chosen === null ? { canceled: true, filePath: '' } : { canceled: false, filePath: chosen }
    }
  }, path)
}

const saveOptions = async (app: App): Promise<Array<{ title?: string, defaultPath?: string, filters?: Array<{ name: string }> }>> =>
  await app.evaluate(() => (globalThis as unknown as { __saveOptions: Array<{ title?: string }> }).__saveOptions)

const toastPage = (app: App): Page | undefined => app.windows().find((w) => w.url().includes('overlay=toast'))

/** The toast's visible words, or null while none is up. */
async function toastText (app: App): Promise<string | null> {
  if (!(await popoverShown(app, 'overlay=toast'))) return null
  const page = toastPage(app)
  if (page === undefined) return null
  try { return (await page.locator('.toast').innerText({ timeout: 500 })).replace(/\s+/g, ' ').trim() } catch { return null }
}

const waitForToast = async (app: App, text: string): Promise<boolean> => await waitFor(async () => (await toastText(app))?.startsWith(text) === true)

/** An overlay's page once Playwright lists it: the host can report the view shown a moment before `app.windows()` does. */
async function overlayPage (app: App, name: string): Promise<Page> {
  expect(await waitFor(() => app.windows().some((w) => w.url().includes(`overlay=${name}`)))).toBe(true)
  return app.windows().find((w) => w.url().includes(`overlay=${name}`)) as Page
}

async function menuPage (app: App, chrome: Page): Promise<Page> {
  await chrome.click('#menu')
  expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
  expect(await waitFor(() => app.windows().some((w) => w.url().includes('overlay=menu')))).toBe(true)
  const menu = app.windows().find((w) => w.url().includes('overlay=menu')) as Page
  await menu.waitForSelector('.menu-row')
  return menu
}

/** Runs a command from the main menu: the row named `label`, inside More tools when `inMore`. */
async function fromMenu (app: App, chrome: Page, label: string, inMore: boolean): Promise<void> {
  const menu = await menuPage(app, chrome)
  if (inMore) await menu.locator('.menu-row', { hasText: 'More tools' }).click()
  await menu.getByRole('menuitem', { name: new RegExp(`^${label}`) }).click()
  expect(await waitFor(async () => !(await popoverShown(app, 'overlay=menu')))).toBe(true)
  await delay(350)
}

const tabContentsUrl = async (app: App, part: string): Promise<boolean> =>
  await app.evaluate(({ webContents }, p) => webContents.getAllWebContents().some((wc) => wc.getURL().startsWith(p)), part)

/** A key that closes a fresh overlay destroys the page it was sent to, which Playwright reports as a failed press. */
async function closingPress (page: Page, key: string): Promise<void> {
  await page.keyboard.press(key).catch(() => {})
}

const pngSize = (path: string): { width: number, height: number } => {
  const bytes = readFileSync(path)
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

async function shoot (app: App, page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  const chrome = findChrome(app)
  for (const scheme of ['light', 'dark'] as const) {
    await chrome.emulateMedia({ colorScheme: scheme })
    await page.emulateMedia({ colorScheme: scheme })
    await delay(300)
    await page.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
    // The whole virtual screen, to judge where the surface sits over the page; absent tools only skip it.
    try { execFileSync('import', ['-window', 'root', join(SHOTS_DIR, `${name}-window-${scheme}.png`)]) } catch { /* not installed */ }
  }
  await chrome.emulateMedia({ colorScheme: null })
  await page.emulateMedia({ colorScheme: null })
}

it('Ctrl+S saves the page complete, or as one .mhtml file by its extension, and names it in a toast', async () => {
  const { app, chrome } = await launched(`${origin}/`)
  try {
    // The suggested name comes from the title, which arrives after the address.
    expect((await waitForTab(chrome, { title: 'Fixture: page tools' })).ok).toBe(true)
    const html = join(outDir, 'page.html')
    await stubSaveDialog(app, html)
    await pressKey(app, origin, 'S', ['control'])
    expect(await waitForToast(app, 'Saved page.html')).toBe(true)
    expect(readFileSync(html, 'utf8')).toContain(MARKER)
    const [shown] = await saveOptions(app)
    expect(shown?.title).toBe('Save page as')
    expect(shown?.defaultPath).toMatch(/Fixture page tools\.html$/)
    expect(shown?.filters?.map((filter) => filter.name)).toEqual(['Web page, complete (*.html)', 'Web page, single file (*.mhtml)'])
    await shoot(app, toastPage(app) as Page, 'toast-saved')

    const mhtml = join(outDir, 'page.mhtml')
    await stubSaveDialog(app, mhtml)
    await pressKey(app, origin, 'S', ['control'])
    // The file appears before its bytes are written: wait for the whole archive.
    expect(await waitFor(() => existsSync(mhtml) && readFileSync(mhtml, 'utf8').includes('MIME-Version'))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('a cancelled dialog writes no file and shows no toast', async () => {
  const { app } = await launched(`${origin}/`)
  try {
    await stubSaveDialog(app, null)
    await pressKey(app, origin, 'S', ['control'])
    expect(await waitFor(async () => (await saveOptions(app)).length === 1)).toBe(true)
    await delay(ABSENCE_SETTLE_MS)
    expect(await toastText(app)).toBeNull()
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('a page that is an image is downloaded as the file it is', async () => {
  const { app } = await launched(`${origin}/pic.png`)
  try {
    const target = join(outDir, 'pic-copy.png')
    await stubSaveDialog(app, target)
    await pressKey(app, origin, 'S', ['control'])
    expect(await waitForToast(app, 'Saved pic-copy.png')).toBe(true)
    expect(readFileSync(target).equals(PNG)).toBe(true)
    expect((await saveOptions(app))[0]?.title).toBe('Save as')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('Save as PDF, from More tools, writes a PDF behind a "Saving PDF…" toast', async () => {
  const { app, chrome } = await launched(`${origin}/`)
  try {
    const target = join(outDir, 'page.pdf')
    await stubSaveDialog(app, target)
    await fromMenu(app, chrome, 'Save as PDF', true)
    expect(await waitForToast(app, 'Saved page.pdf')).toBe(true)
    expect(readFileSync(target).subarray(0, 4).toString('latin1')).toBe('%PDF')
    expect(existsSync(`${target}.part`)).toBe(false)
    expect((await saveOptions(app))[0]?.title).toBe('Save as PDF')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('Ctrl+U opens the source beside the page, in a foreground tab that shows the view-source address', async () => {
  const { app, chrome } = await launched(`${origin}/`)
  try {
    const before = await tabIds(chrome)
    await pressKey(app, origin, 'U', ['control'])
    expect(await waitFor(async () => (await tabIds(chrome)).length === 2)).toBe(true)
    const ids = await tabIds(chrome)
    expect(ids[0]).toBe(before[0])
    expect((await waitForTab(chrome, { activeId: ids[1] })).ok).toBe(true)
    expect(await waitFor(async () => String((await evaluateRetrying(chrome, () => (document.querySelector('#address') as HTMLInputElement).value))).startsWith('view-source:'))).toBe(true)
    expect(await waitFor(async () => await tabContentsUrl(app, `view-source:${origin}/`))).toBe(true)
    // `executeJavaScript` on the contents hangs on a source view; the main frame answers.
    const text = await app.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find((c) => c.getURL().startsWith('view-source:'))
      return await wc?.mainFrame.executeJavaScript('document.body.innerText') as string
    })
    expect(text).toContain(MARKER)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('View page source does nothing on a page that is not on the web', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)
    await pressKey(app, '/renderer/index.html', 'U', ['control'])
    await delay(ABSENCE_SETTLE_MS)
    expect(await tabIds(chrome)).toHaveLength(1)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('Ctrl+P prints with backgrounds on; with no printer it never prints and goes straight to Save as PDF, which saves', async () => {
  const { app } = await launched(`${origin}/`)
  try {
    // With no printer the real call never comes back: the tool must not make it.
    await app.evaluate(({ webContents }, part) => {
      const wc = webContents.getAllWebContents().find((c) => c.getURL().startsWith(part as string))
      if (wc === undefined) throw new Error('no tab')
      const g = globalThis as unknown as { __printed: unknown[] }
      g.__printed = []
      wc.getPrintersAsync = (async () => []) as never
      wc.print = ((options: unknown) => { g.__printed.push(options) }) as never
    }, origin)
    const target = join(outDir, 'from-print.pdf')
    await stubSaveDialog(app, target)
    await pressKey(app, origin, 'P', ['control'])
    expect(await waitForToast(app, 'Saved from-print.pdf')).toBe(true)
    expect(await app.evaluate(() => (globalThis as unknown as { __printed: unknown[] }).__printed)).toEqual([])
    expect(readFileSync(target).subarray(0, 4).toString('latin1')).toBe('%PDF')
    expect((await saveOptions(app))[0]?.title).toBe('Save as PDF')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('with a printer, print is called with backgrounds on and the system dialog', async () => {
  const { app } = await launched(`${origin}/`)
  try {
    await app.evaluate(({ webContents }, part) => {
      const wc = webContents.getAllWebContents().find((c) => c.getURL().startsWith(part as string))
      if (wc === undefined) throw new Error('no tab')
      const g = globalThis as unknown as { __printed: unknown[] }
      g.__printed = []
      wc.getPrintersAsync = (async () => [{ name: 'fake' }]) as never
      wc.print = ((options: unknown, done: (ok: boolean, reason: string) => void) => { g.__printed.push(options); done(false, 'cancelled') }) as never
    }, origin)
    await pressKey(app, origin, 'P', ['control'])
    expect(await waitFor(async () => (await app.evaluate(() => (globalThis as unknown as { __printed: unknown[] }).__printed)).length === 1)).toBe(true)
    expect(await app.evaluate(() => (globalThis as unknown as { __printed: unknown[] }).__printed)).toEqual([{ silent: false, printBackground: true }])
    await delay(ABSENCE_SETTLE_MS)
    expect(await toastText(app)).toBeNull()
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('the toast never takes focus, and a saved one that offers to show the file stays eight seconds', async () => {
  const { app } = await launched(`${origin}/`)
  try {
    await stubSaveDialog(app, join(outDir, 'toast.html'))
    await pressKey(app, origin, 'S', ['control'])
    expect(await waitForToast(app, 'Saved')).toBe(true)
    const role = await (toastPage(app) as Page).locator('.toast').getAttribute('role')
    expect(role).toBe('status')
    // The link that shows the saved file in its folder (never pressed here: it would open a file manager) and a way to dismiss.
    expect(await (toastPage(app) as Page).locator('.toast .link-btn').textContent()).toBe('Show in folder')
    expect(await (toastPage(app) as Page).locator('.toast .toast-dismiss').getAttribute('aria-label')).toBe('Dismiss')
    const shownAt = Date.now()
    expect(await waitFor(async () => !(await popoverShown(app, 'overlay=toast')), 12_000)).toBe(true)
    // Longer than a toast with nothing to do, which goes after three seconds.
    expect(Date.now() - shownAt).toBeGreaterThan(6000)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('Ctrl+Shift+S opens the sheet; the visible area is saved at the page\'s own width, and the full page at its own height', async () => {
  const { app } = await launched(`${origin}/`)
  try {
    const site = app.windows().find((w) => w.url() === `${origin}/`) as Page
    const view = await evaluateRetrying(site, () => ({ width: innerWidth, height: innerHeight, page: document.documentElement.scrollHeight }))
    await pressKey(app, origin, 'S', ['control', 'shift'])
    expect(await waitFor(async () => await popoverShown(app, 'overlay=screenshot'))).toBe(true)
    const sheet = await overlayPage(app, 'screenshot')
    await sheet.waitForSelector('.shot')
    expect(await sheet.locator('h1.sheet-title').innerText()).toBe('Take a screenshot')
    expect(await sheet.locator('.btn.primary').innerText()).toBe('Copy')
    expect(await sheet.evaluate(() => document.activeElement?.textContent)).toBe('Copy')
    expect(await sheet.getByRole('button', { name: 'Full page' }).isDisabled()).toBe(false)
    await shoot(app, sheet, 'sheet')

    const visible = join(outDir, 'visible.png')
    await stubSaveDialog(app, visible)
    await sheet.getByRole('button', { name: 'Save…' }).click()
    expect(await waitFor(async () => !(await popoverShown(app, 'overlay=screenshot')))).toBe(true)
    expect(await waitForToast(app, 'Saved visible.png')).toBe(true)
    expect(pngSize(visible)).toEqual({ width: view.width, height: view.height })
    expect((await saveOptions(app))[0]?.defaultPath).toMatch(/Screenshot \d{4}-\d\d-\d\d at \d\d\.\d\d\.\d\d\.png$/)

    await pressKey(app, origin, 'S', ['control', 'shift'])
    expect(await waitFor(async () => await popoverShown(app, 'overlay=screenshot'))).toBe(true)
    const again = await overlayPage(app, 'screenshot')
    await again.waitForSelector('.shot')
    await again.getByRole('button', { name: 'Full page' }).click()
    expect(await again.getByRole('button', { name: 'Full page' }).getAttribute('aria-pressed')).toBe('true')
    const full = join(outDir, 'full.png')
    await stubSaveDialog(app, full)
    await again.getByRole('button', { name: 'Save…' }).click()
    expect(await waitForToast(app, 'Saved full.png')).toBe(true)
    const size = pngSize(full)
    expect(size.height).toBeGreaterThan(view.height)
    expect(size.height).toBe(view.page)
    // Taking it did not resize the page the person is looking at.
    expect(await evaluateRetrying(site, () => innerHeight)).toBe(view.height)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('Copy puts the picture on the clipboard, Escape and the shortcut close the sheet, and the full page is off while developer tools are open', async () => {
  const { app } = await launched(`${origin}/`)
  try {
    await app.evaluate(({ clipboard, webContents }, part) => {
      const g = globalThis as unknown as { __copied: number }
      g.__copied = 0
      ;(clipboard as unknown as { write: (items: unknown[]) => Promise<void> }).write = async (items) => { g.__copied += items.length }
      const wc = webContents.getAllWebContents().find((c) => c.getURL().startsWith(part as string))
      if (wc === undefined) throw new Error('no tab')
      wc.isDevToolsOpened = () => true
    }, origin)
    await pressKey(app, origin, 'S', ['control', 'shift'])
    expect(await waitFor(async () => await popoverShown(app, 'overlay=screenshot'))).toBe(true)
    const sheet = await overlayPage(app, 'screenshot')
    await sheet.waitForSelector('.shot')
    const full = sheet.getByRole('button', { name: 'Full page' })
    expect(await full.isDisabled()).toBe(true)
    expect(await full.getAttribute('title')).toBe('Close developer tools to capture the full page')
    await shoot(app, sheet, 'sheet-devtools-open')

    await closingPress(sheet, 'Escape')
    expect(await waitFor(async () => !(await popoverShown(app, 'overlay=screenshot')))).toBe(true)
    await delay(350)

    await pressKey(app, origin, 'S', ['control', 'shift'])
    expect(await waitFor(async () => await popoverShown(app, 'overlay=screenshot'))).toBe(true)
    await pressKey(app, origin, 'S', ['control', 'shift'])
    expect(await waitFor(async () => !(await popoverShown(app, 'overlay=screenshot')))).toBe(true)
    await delay(350)

    await pressKey(app, origin, 'S', ['control', 'shift'])
    expect(await waitFor(async () => await popoverShown(app, 'overlay=screenshot'))).toBe(true)
    const third = await overlayPage(app, 'screenshot')
    await third.waitForSelector('.shot')
    await third.getByRole('button', { name: 'Copy' }).click()
    expect(await waitForToast(app, 'Screenshot copied')).toBe(true)
    expect(await app.evaluate(() => (globalThis as unknown as { __copied: number }).__copied)).toBe(1)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('the sheet is operated from the keyboard: the arrows choose the area and Enter takes the focused button', async () => {
  const { app } = await launched(`${origin}/`)
  try {
    await app.evaluate(({ clipboard }) => {
      const g = globalThis as unknown as { __copied: number }
      g.__copied = 0
      ;(clipboard as unknown as { write: (items: unknown[]) => Promise<void> }).write = async (items) => { g.__copied += items.length }
    })
    await pressKey(app, origin, 'S', ['control', 'shift'])
    expect(await waitFor(async () => await popoverShown(app, 'overlay=screenshot'))).toBe(true)
    const sheet = await overlayPage(app, 'screenshot')
    await sheet.waitForSelector('.shot')
    await sheet.getByRole('button', { name: 'Visible area' }).focus()
    await sheet.keyboard.press('ArrowRight')
    expect(await sheet.getByRole('button', { name: 'Full page' }).getAttribute('aria-pressed')).toBe('true')
    expect(await sheet.evaluate(() => document.activeElement?.textContent)).toBe('Full page')
    await sheet.keyboard.press('ArrowLeft')
    expect(await sheet.getByRole('button', { name: 'Visible area' }).getAttribute('aria-pressed')).toBe('true')
    await sheet.getByRole('button', { name: 'Copy' }).focus()
    await closingPress(sheet, 'Enter')
    expect(await waitFor(async () => (await app.evaluate(() => (globalThis as unknown as { __copied: number }).__copied)) === 1)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('Picture in picture, from More tools, pops the page\'s video out and a second run puts it back', async () => {
  const { app, chrome } = await launched(`${origin}/`)
  try {
    const inPip = async (): Promise<boolean> => await app.evaluate(async ({ webContents }, part) => {
      const wc = webContents.getAllWebContents().find((c) => c.getURL().startsWith(part as string))
      return await wc?.mainFrame.executeJavaScript('document.pictureInPictureElement !== null') as boolean
    }, origin)
    expect(await waitFor(async () => await app.evaluate(async ({ webContents }, part) => {
      const wc = webContents.getAllWebContents().find((c) => c.getURL().startsWith(part as string))
      return await wc?.mainFrame.executeJavaScript('(document.getElementById("v")?.readyState ?? 0) > 1') as boolean
    }, origin))).toBe(true)
    await fromMenu(app, chrome, 'Picture in picture', true)
    expect(await waitFor(inPip)).toBe(true)
    await fromMenu(app, chrome, 'Picture in picture', true)
    expect(await waitFor(async () => !(await inPip()))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('Picture in picture pops out a video inside a page element\'s shadow root, from More tools and from the point right-clicked', async () => {
  const { app, chrome } = await launched(`${origin}/shadow`)
  try {
    const inPage = async (code: string): Promise<unknown> => await app.evaluate(async ({ webContents }, [part, script]) => {
      const wc = webContents.getAllWebContents().find((c) => c.getURL().startsWith(part as string))
      return await wc?.mainFrame.executeJavaScript(script as string, true)
    }, [`${origin}/shadow`, code])
    const inPip = async (): Promise<boolean> => await inPage('document.pictureInPictureElement !== null') === true
    expect(await waitFor(async () => await inPage('(document.querySelector("video-card")?.shadowRoot?.getElementById("v")?.readyState ?? 0) > 1') === true)).toBe(true)
    await fromMenu(app, chrome, 'Picture in picture', true)
    expect(await waitFor(inPip)).toBe(true)
    await fromMenu(app, chrome, 'Picture in picture', true)
    expect(await waitFor(async () => !(await inPip()))).toBe(true)
    // The right-click item's script, aimed at the middle of the video, finds it through the element and puts it back the second time.
    expect(await inPage(pointScript(160, 90))).toBe(true)
    expect(await waitFor(inPip)).toBe(true)
    expect(await inPage(pointScript(160, 90))).toBe(true)
    expect(await waitFor(async () => !(await inPip()))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('Picture in picture on a page with no video says so', async () => {
  const { app, chrome } = await launched(`${origin}/novideo`)
  try {
    await fromMenu(app, chrome, 'Picture in picture', true)
    expect(await waitForToast(app, 'No video to pop out on this page')).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('a served PDF opens in an ordinary tab, in the built-in viewer, and is not downloaded', async () => {
  const { app } = await launched(`${origin}/doc.pdf`)
  try {
    expect(await app.evaluate(({ session }) => typeof session.defaultSession.on)).toBe('function')
    await app.evaluate(({ session }) => {
      const g = globalThis as unknown as { __downloads: number }
      g.__downloads = 0
      session.defaultSession.on('will-download', () => { g.__downloads += 1 })
    })
    const viewerFrame = async (): Promise<boolean> => await app.evaluate(({ webContents }, part) => {
      const wc = webContents.getAllWebContents().find((c) => c.getURL().startsWith(part as string))
      return wc?.mainFrame.framesInSubtree.some((frame) => frame.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')) === true
    }, origin)
    expect(await waitFor(viewerFrame, 15_000)).toBe(true)
    expect(await app.evaluate(() => (globalThis as unknown as { __downloads: number }).__downloads)).toBe(0)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('the main menu lists the page tools under their keys', async () => {
  const { app, chrome } = await launched(`${origin}/`)
  try {
    const menu = await menuPage(app, chrome)
    const rows = await menu.locator('.menu-row .menu-label').allTextContents()
    expect(rows).toEqual(expect.arrayContaining(['Print', 'Save page as']))
    expect(await menu.locator('.menu-row', { hasText: 'Save page as' }).locator('.menu-keys').textContent()).toBe('Ctrl+S')
    expect(await menu.locator('.menu-row', { hasText: 'Print' }).locator('.menu-keys').textContent()).toBe('Ctrl+P')
    await menu.locator('.menu-row', { hasText: 'More tools' }).click()
    const more = await menu.locator('.menu-row .menu-label').allTextContents()
    expect(more).toEqual(expect.arrayContaining(['Take a screenshot', 'Picture in picture', 'Save as PDF', 'View page source']))
    await shoot(app, menu, 'menu-more-tools')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
