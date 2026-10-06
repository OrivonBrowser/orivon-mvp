// A document opened from this computer is an origin of its own and runs in a session that serves it under a policy:
// no web page and no web frame in a local page reaches a file:, a local page reads no sibling and no other file, a file
// that lands in an ordinary tab ends in the local-files session, and a local file holds no cookie, no extension script
// and no Orivon permission. Real clicks drive the pages; the main process loads a file into a tab the way history does.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from '../support/launch-electron.mjs'
import { html, launchShell, startServer, visit } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, tabIds, waitFor } from '../support/smoke-helpers.mjs'

const E2E_TIMEOUT_MS = 240_000
const LOCAL_PARTITION = 'orivon-local-files'

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
  await attempt('workerSibling', () => new Promise((resolve, reject) => { const w = new Worker('worker.js'); w.onmessage = (e) => resolve('read:' + e.data); w.onerror = () => reject(new Error('worker')) }))
  result.done = true
  document.body.dataset.result = JSON.stringify(result)
}
run()
</script>`

const STATE_PAGE = `<!doctype html><title>state</title><body><script>
const result = {}
try { history.replaceState({}, '', 'sibling.html'); result.replaced = location.pathname.split('/').pop() } catch (error) { result.replaced = 'threw' }
document.cookie = 'k=v'
result.cookie = document.cookie
result.orivon = typeof window.orivon
const asked = typeof window.orivon === 'object' && window.orivon !== null && window.orivon.app && window.orivon.app.grants
Promise.resolve(asked ? window.orivon.app.grants().then((grants) => 'granted:' + JSON.stringify(grants), (error) => 'rejected:' + (error && error.code)) : 'no-api')
  .then((answer) => { result.grants = answer; document.body.dataset.result = JSON.stringify(result) })
</script>`

const SIBLING_PAGE = `<!doctype html><title>sibling</title><body>sibling<script>document.title = 'sibling opener=' + String(window.opener)</script>`

const INDEX_PAGE = `<!doctype html><title>index</title><body style="font:16px sans-serif">
<a id="link" href="sibling.html">sibling</a>
<a id="blank" target="_blank" href="sibling.html">blank</a>
<button id="open">open</button>
<script>document.getElementById('open').addEventListener('click', () => { document.body.dataset.opened = String(window.open('sibling.html')) })</script>`

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
    html(response, webPage(target, path === '/meta' ? 'meta' : path === '/inner' ? 'inner' : 'main'))
  })
  const write = (name: string, body: string): void => { writeFileSync(join(dir, name), body) }
  write('index.html', INDEX_PAGE)
  write('sibling.html', SIBLING_PAGE)
  write('secret.txt', 'sibling-secret')
  write('worker.js', "postMessage('worker-ran')")
  write('reads.html', READS_PAGE)
  write('state.html', STATE_PAGE)
  write('frames.html', `<!doctype html><title>frames</title><body><iframe src="${web.origin}/inner"></iframe>`)
})

afterAll(async () => {
  await web.close()
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface LocalPage { readonly url: string, readonly local: boolean, readonly origin: string, readonly frames: string[] }

/** Every web contents showing something under this run's folder, with the session it is in. */
async function localPages (app: ElectronApplication): Promise<LocalPage[]> {
  return await app.evaluate(({ session, webContents }, { part, partition }) => {
    const local = session.fromPartition(partition)
    return webContents.getAllWebContents()
      .filter((wc) => !wc.isDestroyed() && wc.mainFrame.framesInSubtree.some((frame) => frame.url.includes(part)))
      .map((wc) => ({ url: wc.getURL(), local: wc.session === local, origin: wc.mainFrame.origin, frames: wc.mainFrame.framesInSubtree.map((frame) => frame.url) }))
  }, { part: token, partition: LOCAL_PARTITION })
}

/** The page Playwright shows for the file at `name`. */
async function filePage (app: ElectronApplication, name: string): Promise<Page> {
  const url = file(name)
  expect(await waitFor(() => app.windows().some((w) => w.url().split('#')[0] === url))).toBe(true)
  return app.windows().find((w) => w.url().split('#')[0] === url) as Page
}

/** Loads `name` into the web page's tab from the main process, as history or a restore does: no `will-navigate`, in the session the tab is in. */
async function loadFileInTab (app: ElectronApplication, from: string, name: string): Promise<void> {
  await app.evaluate(({ webContents }, { source, target }) => {
    const wc = webContents.getAllWebContents().find((candidate) => candidate.getURL() === source)
    if (wc === undefined) throw new Error('no tab at ' + source)
    void wc.loadURL(target)
  }, { source: from, target: file(name) })
}

async function result (page: Page): Promise<Record<string, unknown>> {
  await page.waitForFunction(() => document.body.dataset['result'] !== undefined, undefined, { timeout: 20_000 })
  return JSON.parse(await page.evaluate(() => document.body.dataset['result'] ?? '{}')) as Record<string, unknown>
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

    // A redirect and a meta refresh from the web, and a web frame inside a local page.
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
    await filePage(app, 'frames.html')
    const before = await tabCount(chrome)
    const frame = (await filePage(app, 'frames.html')).frames().find((candidate) => candidate.url().startsWith(web.origin))
    expect(frame).toBeDefined()
    await frame?.click('#blank').catch(() => undefined)
    await delay(ABSENCE_SETTLE_MS)
    const pages = await localPages(app)
    expect(pages.map((page) => page.url)).toEqual([file('frames.html')])
    expect(pages[0]?.local).toBe(true)
    expect(await tabCount(chrome)).toBe(before)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('a file that lands in an ordinary tab ends in the local-files session, and a local page reads no sibling and no other file', async () => {
  const { app, chrome } = await launchShell()
  try {
    const view = await visit(app, chrome, `${web.origin}/`)
    await loadFileInTab(app, view.url(), 'reads.html')
    const page = await filePage(app, 'reads.html')
    const reads = await result(page)
    expect(reads['done']).toBe(true)
    for (const name of ['fetchSibling', 'fetchOther', 'xhrSibling', 'objectSibling', 'frameSibling', 'frameOther', 'workerSibling']) {
      expect({ name, read: reads[name] }).toEqual({ name, read: 'blocked' })
    }
    const pages = await localPages(app)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ url: file('reads.html'), local: true, origin: 'file://' })
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('a local file holds no cookie and no permission, and replaceState onto a sibling keeps it denied', async () => {
  const { app, chrome } = await launchShell()
  try {
    const view = await visit(app, chrome, `${web.origin}/`)
    await loadFileInTab(app, view.url(), 'state.html')
    const page = await filePage(app, 'sibling.html').catch(async () => await filePage(app, 'state.html'))
    const state = await result(page)
    expect(state['cookie']).toBe('')
    expect(String(state['grants'])).not.toMatch(/^granted:/)
    expect(String(state['grants'])).toMatch(/denied|no-api/)
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
    const before = await tabCount(chrome)

    await index.click('#open')
    expect(await waitFor(async () => (await tabCount(chrome)) === before + 1)).toBe(true)
    expect(await index.evaluate(() => document.body.dataset['opened'])).toBe('null')
    const sibling = await filePage(app, 'sibling.html')
    expect(await sibling.title()).toBe('sibling opener=null')

    await index.click('#link')
    expect(await waitFor(async () => (await localPages(app)).some((page) => page.url === file('sibling.html') && page.local))).toBe(true)
    for (const page of await localPages(app)) expect(page.local).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)
