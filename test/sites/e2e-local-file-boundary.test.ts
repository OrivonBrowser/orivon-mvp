// A document opened from this computer is an origin of its own: no web page and no web frame in a local page reaches a
// file:, a local page reads no other file's bytes or pixels, a file that lands in an ordinary tab (history, a reload)
// ends in the session it belongs in, a file recorded as allowed to use Orivon permissions has a session of its own that
// no other file shares, and a download cannot be named after it. Real clicks drive the pages; the main process
// loads a file into a tab the way history does. Runs on a binary whose file-protocol fuse is off (`npm run install:electron`).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from '../support/launch-electron.mjs'
import { html, launchShell, startServer, visit } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, popoverShown, tabIds, waitFor } from '../support/smoke-helpers.mjs'

const E2E_TIMEOUT_MS = 240_000
const SHARED_PARTITION = 'persist:orivon-local-files'
const ownPartition = (key: string): string => `persist:local-${createHash('sha256').update(key, 'utf8').digest('hex')}`
/** A 1x1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

let dir: string
let token: string
let web: FixtureServer
const file = (name: string): string => pathToFileURL(join(dir, name)).href

const READS_PAGE = `<!doctype html><title>reads</title><body><script>
const result = {}
const attempt = async (name, run) => { try { result[name] = await Promise.race([run(), new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000))]) } catch (error) { result[name] = 'blocked' } }
const frameText = (tag, url) => new Promise((resolve) => {
  const element = document.createElement(tag)
  element.setAttribute(tag === 'object' ? 'data' : 'src', url)
  element.onload = () => { try { resolve('read:' + element.contentDocument.body.innerText) } catch (error) { resolve('blocked') } }
  element.onerror = () => resolve('blocked')
  document.body.appendChild(element)
})
const run = async () => {
  await attempt('fetchSibling', async () => 'read:' + await (await fetch('secret.txt')).text())
  await attempt('fetchOther', async () => 'read:' + await (await fetch(${JSON.stringify(pathToFileURL('/etc/hostname').href)})).text())
  await attempt('xhrSibling', () => new Promise((resolve, reject) => { const x = new XMLHttpRequest(); x.open('GET', 'secret.txt'); x.onload = () => resolve('read:' + x.responseText); x.onerror = () => reject(new Error('xhr')); x.send() }))
  await attempt('objectSibling', () => frameText('object', 'secret.txt'))
  await attempt('frameSibling', () => frameText('iframe', 'secret.txt'))
  await attempt('frameOther', () => frameText('iframe', ${JSON.stringify(pathToFileURL('/etc/hostname').href)}))
  await attempt('canvasSibling', () => new Promise((resolve) => { const i = new Image(); i.onload = () => { try { const c = document.createElement('canvas'); c.width = c.height = 1; c.getContext('2d').drawImage(i, 0, 0); c.getContext('2d').getImageData(0, 0, 1, 1); resolve('read') } catch (e) { resolve(e.name) } }; i.onerror = () => resolve('image error'); i.src = 'sibling.png' }))
  await attempt('leak', () => new Promise((resolve) => { const s = document.createElement('script'); s.src = 'env.txt'; s.onload = () => resolve(typeof window.LEAK_ENV); s.onerror = () => resolve(typeof window.LEAK_ENV); document.body.appendChild(s) }))
  await attempt('workerSibling', () => new Promise((resolve, reject) => { const w = new Worker('worker.js'); w.onmessage = (e) => resolve('read:' + e.data); w.onerror = () => reject(new Error('worker')) }))
  result.done = true
  document.body.dataset.result = JSON.stringify(result)
}
run()
</script>`

/** An XML document with its own stylesheet, which asks `document()` for a sibling's text. */
const XSLT_PAGE = `<?xml version="1.0"?>
<?xml-stylesheet type="text/xsl" href="#style"?>
<!DOCTYPE doc [<!ATTLIST xsl:stylesheet id ID #REQUIRED>]>
<doc><xsl:stylesheet id="style" version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
<xsl:output method="html"/>
<xsl:template match="/"><html><body><div id="out">[<xsl:value-of select="document('secret.xml')"/>]</div></body></html></xsl:template>
</xsl:stylesheet></doc>`

const STATE_PAGE = `<!doctype html><title>state</title><body><script>
const result = {}
try { history.replaceState({}, '', 'sibling.html'); result.replaced = location.pathname.split('/').pop() } catch (error) { result.replaced = 'threw' }
try { localStorage.setItem('k', 'v'); result.localStorage = 'works' } catch (error) { result.localStorage = 'threw' }
document.cookie = 'k=v'
result.cookie = document.cookie
result.orivon = typeof window.orivon
const asked = typeof window.orivon === 'object' && window.orivon !== null && window.orivon.app && window.orivon.app.grants
Promise.resolve(asked ? window.orivon.app.grants().then((grants) => 'granted:' + JSON.stringify(grants), (error) => 'rejected:' + (error && error.code)) : 'no-api')
  .then((answer) => { result.grants = answer; document.body.dataset.result = JSON.stringify(result) })
</script>`

const SIBLING_PAGE = `<!doctype html><title>sibling</title><body>sibling-body-marker<script>document.title = 'sibling opener=' + String(window.opener)</script>`

const INDEX_PAGE = `<!doctype html><title>index</title><body style="font:16px sans-serif">
<a id="link" href="sibling.html">sibling</a>
<a id="blank" target="_blank" href="sibling.html">blank</a>
<button id="open">open</button>
<script>document.getElementById('open').addEventListener('click', () => { document.body.dataset.opened = String(window.open('sibling.html')) })</script>`

/** Writes a database, then lists the databases this origin's session holds. `link` is the page to follow afterwards. */
const storagePage = (name: string, link: string): string => `<!doctype html><title>${name}</title><body>
<a id="next" href="${link}">next</a><iframe id="frame" src="sibling.html"></iframe><script>
const open = new Promise((resolve, reject) => { const request = indexedDB.open('${name}-db', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
open.then(async (db) => { db.close(); document.body.dataset.result = JSON.stringify((await indexedDB.databases()).map((d) => d.name).sort()) })
</script>`

function webPage (url: string, kind: string): string {
  switch (kind) {
    case 'main': return `<!doctype html><title>web</title><body style="font:16px sans-serif">
<a id="link" href="${url}">link</a> <a id="blank" target="_blank" href="${url}">blank</a>
<button id="open">open</button> <button id="assign">assign</button>
<iframe id="frame" src="${url}"></iframe>
<script>
document.getElementById('open').addEventListener('click', () => { document.body.dataset.opened = String(window.open(${JSON.stringify(url)})) })
document.getElementById('assign').addEventListener('click', () => { location = ${JSON.stringify(url)} })
</script>`
    case 'meta': return `<!doctype html><title>meta</title><meta http-equiv="refresh" content="0;url=${url}">`
    default: return `<!doctype html><title>inner</title><body style="font:16px sans-serif">
<a id="blank" target="_blank" href="${url}">blank</a>
<script>
try { window.open(${JSON.stringify(url)}) } catch (error) {}
try { top.location = ${JSON.stringify(url)} } catch (error) {}
</script>`
  }
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'orivon-local-')))
  token = basename(dir)
  mkdirSync(join(dir, 'sub'))
  const target = pathToFileURL(join(dir, 'sibling.html')).href
  web = await startServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname
    if (path === '/redirect') { response.statusCode = 302; response.setHeader('location', target); response.end(); return }
    if (path === '/ghost.html') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="ghost.html"' })
      response.end('<!doctype html><title>planted</title>')
      return
    }
    if (path === '/download') { html(response, '<!doctype html><title>dl</title><body><a id="get" download href="/ghost.html">get</a>'); return }
    html(response, webPage(target, path === '/meta' ? 'meta' : path === '/inner' ? 'inner' : 'main'))
  })
  const write = (name: string, body: string | Buffer): void => { writeFileSync(join(dir, name), body) }
  write('index.html', INDEX_PAGE)
  write('sibling.html', SIBLING_PAGE)
  write('sibling.png', PNG)
  write('secret.txt', 'sibling-secret')
  write('secret.xml', '<secret>xslt-secret</secret>')
  write('env.txt', 'LEAK_ENV = "env-secret"')
  write('worker.js', "postMessage('worker-ran')")
  write('reads.html', READS_PAGE)
  write('xslt.xml', XSLT_PAGE)
  write('state.html', STATE_PAGE)
  write('granted.html', storagePage('granted', 'shared.html'))
  write('shared.html', storagePage('shared', 'granted.html'))
  write('frames.html', `<!doctype html><title>frames</title><body><iframe src="${web.origin}/inner"></iframe>`)
})

afterAll(async () => {
  await web.close()
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface LocalPage { readonly url: string, readonly partition: string, readonly origin: string }

/** Every web contents showing something under this run's folder, with the local session it is in ('other' for any other). */
async function localPages (app: ElectronApplication, partitions: string[] = [SHARED_PARTITION]): Promise<LocalPage[]> {
  return await app.evaluate(({ session, webContents }, { part, names }) => {
    return webContents.getAllWebContents()
      .filter((wc) => !wc.isDestroyed() && wc.mainFrame.framesInSubtree.some((frame) => frame.url.includes(part)))
      .map((wc) => ({
        url: wc.getURL(),
        partition: names.find((name) => wc.session === session.fromPartition(name)) ?? 'other',
        origin: wc.mainFrame.origin
      }))
  }, { part: token, names: partitions })
}

/**
 * The page Playwright shows for the file at `name`: the newest one holding the file's document. A file loaded into a
 * web tab moves to a new view in a local session, and until the old view is retired its blocked load still reports
 * the file's address over an error document; on a slow machine the first page on the address is that one.
 */
async function filePage (app: ElectronApplication, name: string): Promise<Page> {
  const url = file(name)
  let found: Page | undefined
  expect(await waitFor(async () => {
    for (const w of [...app.windows()].reverse()) {
      if (w.isClosed() || w.url().split('#')[0] !== url) continue
      if (await w.evaluate(() => location.protocol).catch(() => '') === 'file:') {
        found = w
        return true
      }
    }
    return false
  })).toBe(true)
  return found as Page
}

/** Loads `name` into the tab showing `from` from the main process, as history or a restore does: no `will-navigate`, in the session the tab is in. */
async function loadFileInTab (app: ElectronApplication, from: string, name: string): Promise<void> {
  await app.evaluate(({ webContents }, { source, target }) => {
    const wc = webContents.getAllWebContents().find((candidate) => candidate.getURL() === source)
    if (wc === undefined) throw new Error('no tab at ' + source)
    void wc.loadURL(target)
  }, { source: from, target: file(name) })
}

async function result (page: Page): Promise<unknown> {
  await page.waitForFunction(() => document.body.dataset['result'] !== undefined, undefined, { timeout: 20_000 })
  return JSON.parse(await page.evaluate(() => document.body.dataset['result'] ?? '{}')) as unknown
}

const tabCount = async (chrome: Page): Promise<number> => (await tabIds(chrome)).length

it('a web page and a web frame in a local page reach no file: address, however they ask', async () => {
  const { app, chrome } = await launchShell()
  try {
    const address = `${web.origin}/`
    const view = await visit(app, chrome, address)
    const before = await tabCount(chrome)
    // Real clicks: a link, a target=_blank link, window.open and a location assignment, then a frame.
    await view.click('#link')
    await view.click('#blank')
    await view.click('#open')
    await view.click('#assign')
    await delay(ABSENCE_SETTLE_MS)
    expect(await localPages(app)).toEqual([])
    expect(view.url()).toBe(address)
    expect(await tabCount(chrome)).toBe(before)

    // A redirect and a meta refresh from the web.
    for (const path of ['/redirect', '/meta']) {
      await visit(app, chrome, `${web.origin}${path}`).catch(() => undefined)
      await delay(ABSENCE_SETTLE_MS)
      expect(await localPages(app)).toEqual([])
    }
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('a web frame inside a local page opens no file and navigates nothing to one', async () => {
  const { app, chrome } = await launchShell()
  try {
    const view = await visit(app, chrome, `${web.origin}/`)
    await loadFileInTab(app, view.url(), 'frames.html')
    const local = await filePage(app, 'frames.html')
    const before = await tabCount(chrome)
    expect(await waitFor(() => local.frames().some((candidate) => candidate.url().startsWith(web.origin)))).toBe(true)
    const frame = local.frames().find((candidate) => candidate.url().startsWith(web.origin))
    await frame?.click('#blank').catch(() => undefined)
    await delay(ABSENCE_SETTLE_MS)
    const pages = await localPages(app)
    expect(pages.map((page) => page.url)).toEqual([file('frames.html')])
    expect(pages[0]?.partition).toBe(SHARED_PARTITION)
    expect(await tabCount(chrome)).toBe(before)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('a file that lands in an ordinary tab ends in the local session, and a local page reads no other file by any route', async () => {
  const { app, chrome } = await launchShell()
  try {
    const view = await visit(app, chrome, `${web.origin}/`)
    await loadFileInTab(app, view.url(), 'reads.html')
    const page = await filePage(app, 'reads.html')
    const reads = await result(page) as Record<string, unknown>
    expect(reads['done']).toBe(true)
    for (const name of ['fetchSibling', 'fetchOther', 'xhrSibling', 'objectSibling', 'frameSibling', 'frameOther', 'workerSibling']) {
      expect({ name, read: reads[name] }).toEqual({ name, read: 'blocked' })
    }
    expect(reads['canvasSibling']).toBe('SecurityError')
    expect(reads['leak']).toBe('undefined')
    const pages = await localPages(app)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ url: file('reads.html'), partition: SHARED_PARTITION, origin: 'file://' })

    // XSLT `document()` of a sibling, from a stylesheet the document carries.
    await loadFileInTab(app, file('reads.html'), 'xslt.xml')
    const xslt = await filePage(app, 'xslt.xml')
    await delay(ABSENCE_SETTLE_MS)
    // The transform ran (the output is there) and `document()` of a sibling gave an empty string.
    expect(await xslt.content()).toContain('<div id="out">[]</div>')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('a local file holds no cookie and no permission, and replaceState onto a sibling throws', async () => {
  const { app, chrome } = await launchShell()
  try {
    const view = await visit(app, chrome, `${web.origin}/`)
    await loadFileInTab(app, view.url(), 'state.html')
    const state = await result(await filePage(app, 'state.html')) as Record<string, unknown>
    expect(state['replaced']).toBe('threw')
    expect(state['cookie']).toBe('')
    expect(state['localStorage']).toBe('threw')
    // The page's own script may ask, as any page's may; a file nobody allowed holds nothing.
    expect(state['grants']).toBe('granted:[]')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('a sibling link opens in the same local session, and a sibling window.open opens a tab with no opener', async () => {
  const { app, chrome } = await launchShell()
  try {
    const view = await visit(app, chrome, `${web.origin}/`)
    await loadFileInTab(app, view.url(), 'index.html')
    const index = await filePage(app, 'index.html')

    await index.click('#link')
    expect(await waitFor(async () => (await localPages(app)).some((page) => page.url === file('sibling.html') && page.partition === SHARED_PARTITION))).toBe(true)
    await loadFileInTab(app, file('sibling.html'), 'index.html')
    const again = await filePage(app, 'index.html')
    const before = await tabCount(chrome)

    await again.click('#open')
    expect(await waitFor(async () => (await tabCount(chrome)) === before + 1)).toBe(true)
    expect(await again.evaluate(() => document.body.dataset['opened'])).toBe('null')
    const sibling = await filePage(app, 'sibling.html')
    expect(await sibling.title()).toBe('sibling opener=null')
    for (const page of await localPages(app)) expect(page.partition).toBe(SHARED_PARTITION)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('a recorded file has a session of its own: its IndexedDB is unseen by a sibling, its framed sibling is cancelled, and a reload moves a tab to where the file belongs', async () => {
  const key = file('granted.html')
  const { app, chrome } = await launchShell({
    seedProfile: async (userData: string) => { await writeFile(join(userData, 'local-file-apps.json'), JSON.stringify({ version: 1, files: [key] })) }
  })
  const partitions = [SHARED_PARTITION, ownPartition(key)]
  try {
    const view = await visit(app, chrome, `${web.origin}/`)
    await loadFileInTab(app, view.url(), 'granted.html')
    expect(await waitFor(async () => (await localPages(app, partitions)).some((page) => page.url === key && page.partition === partitions[1]))).toBe(true)
    const granted = await filePage(app, 'granted.html')
    expect(await result(granted)).toEqual(['granted-db'])
    // The sibling in its frame was cancelled by the fence: the frame holds no sibling text.
    expect(await waitFor(() => granted.frames().some((frame) => frame !== granted.mainFrame()))).toBe(true)
    for (const frame of granted.frames().filter((candidate) => candidate !== granted.mainFrame())) {
      expect(await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '')).not.toContain('sibling-body-marker')
    }

    // A link to a file that belongs in the shared session moves the tab there before anything commits; its database list has no 'granted-db'.
    await granted.click('#next')
    const shared = await filePage(app, 'shared.html')
    expect(await result(shared)).toEqual(['shared-db'])
    expect((await localPages(app, partitions)).find((page) => page.url === file('shared.html'))?.partition).toBe(SHARED_PARTITION)

    // loadURL of the recorded file into the shared session: the fence cancels it and the tab moves to the file's own.
    await loadFileInTab(app, file('shared.html'), 'granted.html')
    expect(await waitFor(async () => (await localPages(app, partitions)).some((page) => page.url === key && page.partition === partitions[1]))).toBe(true)
    const again = await filePage(app, 'granted.html')
    expect(await result(again)).toEqual(['granted-db'])
    // The cancelled load is no failure the person needs told of: no load-error sheet is over the page the tab moved to.
    await delay(ABSENCE_SETTLE_MS)
    expect(await popoverShown(app, 'overlay=load-error')).toBe(false)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('a download named like a recorded file is saved under another name', async () => {
  const downloads = realpathSync(mkdtempSync(join(tmpdir(), 'orivon-local-downloads-')))
  const key = pathToFileURL(join(downloads, 'ghost.html')).href
  const { app, chrome } = await launchShell({
    seedProfile: async (userData: string) => {
      await writeFile(join(userData, 'local-file-apps.json'), JSON.stringify({ version: 1, files: [key] }))
      await writeFile(join(userData, 'settings.json'), JSON.stringify({ version: 1, values: { 'downloads.folder': downloads, 'downloads.showBubble': false, 'web3.scoreProvider': '' } }))
    }
  })
  try {
    const view = await visit(app, chrome, `${web.origin}/download`)
    await view.click('#get')
    expect(await waitFor(() => existsSync(join(downloads, 'ghost (1).html')), 30_000)).toBe(true)
    expect(existsSync(join(downloads, 'ghost.html'))).toBe(false)
    expect(readdirSync(downloads).sort()).toEqual(['ghost (1).html'])
  } finally {
    await closeElectron(app)
    rmSync(downloads, { recursive: true, force: true })
  }
}, E2E_TIMEOUT_MS)
