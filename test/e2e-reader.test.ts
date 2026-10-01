// Reader view in the running shell: the book appears in the address bar on an article only, F9 opens the
// article in a tab beside it from a validated block model (nothing from the page's markup survives), the
// text controls change what is drawn and what is stored, F9 again goes back, a page that is not an article
// gets a toast, and a private window stores nothing. Set ORIVON_UI_SHOTS_DIR to also write screenshots.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying, pressKey } from './e2e-helpers.js'
import { delay, findChrome, HERMETIC_RESOLVER, popoverShown, tabIds, waitFor, waitForTab } from './smoke-helpers.mjs'

const SHOTS_DIR = process.env['ORIVON_UI_SHOTS_DIR']
const TEST_TIMEOUT_MS = 120_000
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=', 'base64')
let server: Server
let origin = ''

const PARAGRAPH = 'The quick brown fox jumps over the lazy dog while the afternoon light moves slowly across the quiet valley, and everyone who passes the old mill stops to listen to the water, which has run the same way for longer than anyone in the village can remember.'

function article (): string {
  const paragraphs = Array.from({ length: 8 }, (_, i) => `<p>${PARAGRAPH} Paragraph ${String(i + 1)} ends here.</p>`)
  return `<!doctype html><html lang="en"><head><title>A Long Walk Home - Example Times</title><meta name="author" content="Ada Writer"></head><body>
<nav><a href="/menu">Menu</a></nav>
<article>
<h1>A Long Walk Home</h1>
<p class="byline">By Ada Writer</p>
${paragraphs.slice(0, 2).join('\n')}
<h2>The mill</h2>
${paragraphs.slice(2, 4).join('\n')}
<blockquote><p>Water finds its own way, and so do people who are patient with it.</p></blockquote>
<p>A link to <a href="/other">another page</a> and a <a href="javascript:document.title='hacked'">dangerous one</a> sit in this paragraph, which also carries <em>emphasis</em> and <strong>weight</strong> and some <code>inline code</code> for good measure, so the text is long enough to count.</p>
<pre>const walk = () =&gt; 'home'\nwalk()</pre>
<ul><li>First item of the list</li><li>Second item of the list</li></ul>
<img src="/pic.png" alt="A tiny picture" onerror="document.title='pwned'">
<script>document.title = 'script ran'</script>
${paragraphs.slice(4).join('\n')}
<table><tr><td>Year</td><td>Miles</td></tr><tr><td>2024</td><td>12</td></tr></table>
</article></body></html>`
}

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/pic.png') {
      response.setHeader('content-type', 'image/png')
      response.end(PNG)
      return
    }
    response.setHeader('content-type', 'text/html')
    // A page that runs no script of its own must still be readable.
    response.setHeader('content-security-policy', "script-src 'none'")
    response.end(request.url === '/article' ? article() : '<!doctype html><title>Not an article</title><p>Just a short note.</p>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function launched (args: string[] = []): Promise<{ app: ElectronApplication, chrome: Page, userData: string }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER, ...args] })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  const userData = await app.evaluate(({ app: electron }) => electron.getPath('userData'))
  return { app, chrome: findChrome(app), userData }
}

async function visit (chrome: Page, address: string): Promise<void> {
  await clickAddressBarRetrying(chrome, address)
  expect((await waitForTab(chrome, { address })).ok).toBe(true)
}

const runCommand = async (chrome: Page, id: string): Promise<void> => {
  await chrome.evaluate((command) => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand(command) }, id)
}

const readerPage = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().startsWith('orivon://reader') && !w.isClosed())

async function openedReader (app: ElectronApplication): Promise<Page> {
  expect(await waitFor(() => readerPage(app) !== undefined)).toBe(true)
  return readerPage(app) as Page
}

const bookShown = async (chrome: Page): Promise<boolean> => await chrome.locator('#reader').isVisible()

const toastPage = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().includes('overlay=toast'))
async function toastText (app: ElectronApplication): Promise<string | null> {
  if (!(await popoverShown(app, 'overlay=toast'))) return null
  const page = toastPage(app)
  if (page === undefined) return null
  try { return (await page.locator('.toast').innerText({ timeout: 500 })).replace(/\s+/g, ' ').trim() } catch { return null }
}

async function shoot (page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await delay(350)
    await page.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
}

const setPref = async (page: Page, key: string, value: string): Promise<void> => {
  await page.evaluate(async ([k, v]) => await (window as unknown as { orivonInternal: { request: (d: string, c: unknown) => Promise<unknown> } }).orivonInternal.request('reader', { type: 'pref', key: k, value: v }), [key, value] as const)
}

it('offers reader view on an article only, opens it beside the article from a safe model, and goes back', async () => {
  const { app, chrome, userData } = await launched()
  try {
    // Opened by hand, with nothing to read.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string) => void } }).orivonShell.openInternal('reader') })
    const empty = await openedReader(app)
    await empty.waitForSelector('.empty-state')
    expect(await empty.locator('.empty-state').innerText()).toContain('Nothing to read here yet.')
    await shoot(empty, 'empty')
    await runCommand(chrome, 'tab.new')

    await visit(chrome, `${origin}/article`)
    expect(await waitFor(async () => await bookShown(chrome))).toBe(true)
    await shoot(chrome, 'address-book')
    const before = await tabIds(chrome) as string[]

    await runCommand(chrome, 'page.reader')
    const page = await openedReader(app)
    await page.waitForSelector('h1')
    expect(await page.locator('h1').innerText()).toContain('A Long Walk Home')
    expect(await page.title()).toContain('A Long Walk Home')
    expect(await page.locator('.meta').innerText()).toMatch(/Ada Writer\s+127\.0\.0\.1\s+\d+ min read/)

    // The reader tab sits right of the article's, and the article's tab is still there.
    const after = await tabIds(chrome) as string[]
    const active = await chrome.evaluate(() => (document.querySelector('.tab.active') as HTMLElement).dataset['id'])
    expect(after.length).toBe(before.length)
    expect(after.indexOf(active as string)).toBeGreaterThan(0)
    expect(await chrome.locator('.tab').nth(after.indexOf(active as string) - 1).innerText()).toContain('Long Walk')

    // Nothing from the page's markup is in the reader's document.
    expect(await page.locator('.column script, .column iframe, .column object').count()).toBe(0)
    expect(await page.locator('.column [onerror], .column [onclick], .column [style]').count()).toBe(0)
    expect(await page.locator('a[href]').count()).toBe(0)
    expect(await page.locator('.body').innerHTML()).not.toContain('javascript:')
    expect(await page.locator('.body').innerText()).toContain('dangerous one')
    expect(await page.locator('.body h2').innerText()).toBe('The mill')
    expect(await page.locator('.body blockquote').count()).toBe(1)
    expect(await page.locator('.body pre code').innerText()).toContain('walk()')
    expect(await page.locator('.body ul li').count()).toBe(2)
    expect(await page.locator('.body table td').count()).toBe(4)

    // The picture arrives from main as a data URL.
    await page.waitForSelector('.body figure img')
    expect(await page.locator('.body figure img').getAttribute('src')).toMatch(/^data:image\/png;base64,/)

    // The tab titled with the article is the reader; the source page still has its own title.
    expect(await page.evaluate(() => document.title)).not.toBe('pwned')
    await shoot(page, 'article')
    await page.locator('.body blockquote').scrollIntoViewIfNeeded()
    await shoot(page, 'blocks')
    await page.evaluate(() => { window.scrollTo(0, 0) })

    // Read aloud: no system voice here, so the button is not offered.
    expect(await waitFor(async () => await page.locator('button[aria-label="Read aloud"]').getAttribute('title') === 'Read aloud needs a system voice. None is installed.', 6_000)).toBe(true)
    expect(await page.locator('button[aria-label="Read aloud"]').isHidden()).toBe(true)

    // Text and layout.
    await page.locator('button[aria-label="Text and layout"]').click()
    const bubble = page.locator('.bubble')
    await bubble.waitFor()
    expect(await bubble.getAttribute('role')).toBe('dialog')
    await shoot(page, 'bubble')
    const sizeBefore = await page.evaluate(() => getComputedStyle(document.querySelector('.body') as Element).fontSize)
    expect(sizeBefore).toBe('18px')
    await page.locator('button[aria-label="Larger text"]').click()
    expect(await waitFor(async () => await page.evaluate(() => getComputedStyle(document.querySelector('.body') as Element).fontSize) === '20px')).toBe(true)
    await bubble.getByRole('button', { name: 'Serif' }).click()
    await bubble.getByRole('button', { name: 'Wide' }).click()
    await bubble.getByRole('button', { name: 'Sepia' }).click()
    expect(await waitFor(async () => await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(244, 236, 216)')).toBe(true)
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.body') as Element).fontFamily)).toContain('Georgia')
    expect(await page.evaluate(() => Math.round((document.querySelector('.column') as HTMLElement).getBoundingClientRect().width))).toBe(820)
    expect(await waitFor(async () => {
      try {
        const values = (JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')) as { values: Record<string, string> }).values
        return values['reader.size'] === '20' && values['reader.font'] === 'serif' && values['reader.width'] === 'wide' && values['reader.theme'] === 'sepia'
      } catch { return false }
    })).toBe(true)
    await shoot(page, 'bubble-sepia')
    await page.keyboard.press('Escape')
    expect(await bubble.isHidden()).toBe(true)
    await setPref(page, 'reader.theme', 'dark')
    expect(await waitFor(async () => await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(23, 24, 28)')).toBe(true)
    await setPref(page, 'reader.theme', 'auto')
    await setPref(page, 'reader.font', 'sans')
    await setPref(page, 'reader.width', 'medium')

    // A link opens in a background tab by its index, and a refused command opens nothing.
    const tabsBefore = (await tabIds(chrome) as string[]).length
    await page.locator('.body a').first().click()
    expect(await waitFor(async () => (await tabIds(chrome) as string[]).length === tabsBefore + 1)).toBe(true)
    expect(await page.evaluate(() => (window as unknown as { orivonInternal: { request: (d: string, c: unknown) => Promise<unknown> } }).orivonInternal.request('reader', { type: 'open', url: 'https://evil.test/' }))).toEqual({ ok: false })

    // F9 on the reader goes back to the article and the reader tab is gone.
    await pressKey(app, 'orivon://reader', 'F9')
    expect(await waitFor(() => readerPage(app) === undefined)).toBe(true)
    expect(await waitFor(async () => (await chrome.locator('.tab.active').innerText()).includes('Long Walk'))).toBe(true)

    // Another page: no book, and a toast instead of a tab.
    await runCommand(chrome, 'tab.new')
    await visit(chrome, `${origin}/note`)
    await delay(1_000)
    expect(await bookShown(chrome)).toBe(false)
    await pressKey(app, '/note', 'F9')
    expect(await waitFor(async () => (await toastText(app))?.startsWith('Reader view is not available for this page.') === true)).toBe(true)
    expect(readerPage(app)).toBeUndefined()
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('works in a private window', async () => {
  const { app, chrome } = await launched(['--orivon-private'])
  try {
    await visit(chrome, `${origin}/article`)
    expect(await waitFor(async () => await bookShown(chrome))).toBe(true)
    await runCommand(chrome, 'page.reader')
    const page = await openedReader(app)
    await page.waitForSelector('h1')
    expect(await page.locator('h1').innerText()).toContain('A Long Walk Home')
    await page.locator('button[aria-label="Text and layout"]').click()
    await page.locator('.bubble').getByRole('button', { name: 'Serif' }).click()
    expect(await waitFor(async () => await page.evaluate(() => getComputedStyle(document.querySelector('.body') as Element).fontFamily).then((f) => f.includes('Georgia')))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
