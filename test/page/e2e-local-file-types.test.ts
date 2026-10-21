// What a file opened from this computer shows: an HTML page, an XHTML page, an SVG that runs its own script, a
// picture, plain text, a PDF in the viewer, and a folder as a listing whose names cannot run anything. Each is typed into
// the real address bar as a path. Runs on a binary whose file-protocol fuse is off (`npm run install:electron`).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'

/** A 1x1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const MINIMAL_PDF = [
  '%PDF-1.1',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/MediaBox[0 0 200 200]/Parent 2 0 R>>endobj',
  'trailer<</Root 1 0 R/Size 4>>',
  '%%EOF'
].join('\n')

// Windows file names cannot hold < or >, so there the name is the entity-escaped spelling of the markup: if the listing did not escape the &, the browser would show the markup itself and the name assertion would fail.
const HOSTILE_NAME = process.platform === 'win32' ? '&lt;img src=x onerror=document.title=1&gt;&#39;.txt' : '<img src=x onerror=document.title=1>.txt'

let dir: string
const urlOf = (name: string): string => pathToFileURL(join(dir, name)).href

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'orivon-types-')))
  const write = (name: string, body: string | Buffer): void => { writeFileSync(join(dir, name), body) }
  write('page.html', '<!doctype html><title>html page</title><p id="p">html body</p>')
  write('page.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>xhtml page</title></head><body><p id="p">xhtml body</p></body></html>')
  write('image.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><title>svg image</title><script>document.documentElement.setAttribute("data-ran", "yes")</script><rect width="20" height="20" fill="red"/></svg>')
  write('image.png', PNG)
  write('notes.txt', 'plain text body')
  write('doc.pdf', MINIMAL_PDF)
  mkdirSync(join(dir, 'folder'))
  write(HOSTILE_NAME, 'x')
})

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('opens a web page, an XHTML page, an SVG with its script, a picture and text, each as the document it is', async () => {
  const { app, chrome } = await launchShell()
  try {
    const html = await visit(app, chrome, urlOf('page.html'))
    expect(await html.title()).toBe('html page')
    expect(await html.evaluate(() => document.contentType)).toBe('text/html')

    const xhtml = await visit(app, chrome, urlOf('page.xhtml'))
    expect(await xhtml.evaluate(() => document.contentType)).toBe('application/xhtml+xml')
    expect(await xhtml.locator('#p').innerText()).toBe('xhtml body')

    const svg = await visit(app, chrome, urlOf('image.svg'))
    expect(await svg.evaluate(() => document.contentType)).toBe('image/svg+xml')
    expect(await svg.evaluate(() => document.documentElement.getAttribute('data-ran'))).toBe('yes')

    const png = await visit(app, chrome, urlOf('image.png'))
    expect(await png.evaluate(() => document.contentType)).toBe('image/png')

    const text = await visit(app, chrome, urlOf('notes.txt'))
    expect(await text.evaluate(() => document.contentType)).toBe('text/plain')
    expect(await text.evaluate(() => document.body.innerText)).toContain('plain text body')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('opens a PDF in the viewer and shows a folder as a listing of its names that runs none of them', async () => {
  const { app, chrome } = await launchShell()
  try {
    await clickAddressBarRetrying(chrome, urlOf('doc.pdf'))
    const viewerShown = async (): Promise<boolean> => await app.evaluate(({ webContents }, target) =>
      webContents.getAllWebContents().some((wc) => !wc.isDestroyed() && wc.getURL() === target && wc.mainFrame.framesInSubtree.some((frame) => frame.url.startsWith('chrome-extension://'))), urlOf('doc.pdf'))
    expect(await waitFor(viewerShown, 30_000)).toBe(true)

    const listing = await visit(app, chrome, urlOf('folder').replace(/\/?$/, '/'))
    expect(await listing.title()).toContain('Index of')
    await listing.waitForSelector('h1')
    expect(await listing.locator('li a').count()).toBe(1)

    const folder = await visit(app, chrome, pathToFileURL(dir).href.replace(/\/?$/, '/'))
    const names = await folder.locator('li a').allInnerTexts()
    expect(names).toEqual(expect.arrayContaining(['folder/', 'page.html', 'doc.pdf', HOSTILE_NAME]))
    expect(names.indexOf('folder/')).toBeLessThan(names.indexOf('doc.pdf'))
    // The hostile name is text, not an element: no image was made from it and no handler ran.
    expect(await folder.locator('img').count()).toBe(0)
    expect(await folder.title()).toContain('Index of')
    // A link of the listing opens that file: the person goes from the folder to a page in it.
    await folder.click('a:text-is("page.html")')
    expect(await waitFor(() => app.windows().some((w) => w.url() === urlOf('page.html')))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
