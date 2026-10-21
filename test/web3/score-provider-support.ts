// What the Web3 Score provider specs share: loopback pages whose DDOC tree gives them an identifier, a bucket-file
// builder, and a reader for the shield and the Web3 Score page it opens.
import { createHash } from 'node:crypto'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { findChrome, popoverShown, waitFor } from '../support/smoke-helpers.mjs'
import { readShield } from '../support/e2e-helpers.js'

export const bucketOf = (id: string): string => createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 2)

export async function listen (handler: RequestListener): Promise<{ server: Server, port: number }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { server, port: (server.address() as AddressInfo).port }
}

export async function startSite (title: string, bundleHash: string): Promise<{ server: Server, port: number }> {
  const tree = JSON.stringify({ bundleHash, leaves: { '/index.html': 'sha256:' + 'c'.repeat(64) } })
  return await listen((req, res) => {
    if (req.url === '/.well-known/orivon-ddoc.json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(tree)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body>${title}</body>`)
  })
}

export const bucketFile = (id: string, level: number): string => JSON.stringify({
  standard: 'orivon-web3-score/1', subject: 'website', bucket: bucketOf(id), entries: [{ id, name: 'App', evaluated: '2026-10-03', trustlessity: { level } }]
})

function findPopup (app: ElectronApplication): Page | undefined {
  return app.windows().find((w) => w.url().includes('/site-info/'))
}

export async function readScore (app: ElectronApplication, level: string): Promise<{ level: string | null, mark: string, label: string, heading: string, headings: string[], text: string }> {
  const chrome = findChrome(app)
  // The first answer can be the observed level while the provider is still being asked.
  await waitFor(async () => await chrome.evaluate((want: string) => document.querySelector('#web3-score-btn .web3-shield')?.getAttribute('data-level') === want, level), 8_000)
  const { level: painted, mark } = await readShield(chrome)
  const label = await chrome.evaluate(() => document.querySelector('#web3-score-btn')?.getAttribute('aria-label') ?? '')
  await chrome.click('#web3-score-btn')
  if (!await waitFor(() => findPopup(app) !== undefined, 5_000)) throw new Error('the site popover did not open')
  const popup = findPopup(app)!
  if (!await waitFor(async () => (await popup.$$('.level-list')).length > 0, 5_000)) throw new Error('the Web3 Score page shows no level')
  // Headings are read as written: their CSS uppercases what innerText returns.
  const page = await popup.evaluate(() => ({
    heading: document.querySelector('.level-list')?.previousElementSibling?.textContent ?? '',
    headings: Array.from(document.querySelectorAll('.section-heading'), (el) => el.textContent ?? ''),
    text: document.body.innerText
  }))
  await chrome.click('#web3-score-btn')
  await waitFor(() => findPopup(app) === undefined, 5_000)
  // Past popover-view.ts's reopen debounce, so the next click reads as a fresh open.
  await chrome.waitForTimeout(400)
  return { level: painted, mark, label, ...page }
}


const cardPage = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().includes('overlay=web3-score') && !w.isClosed())

/** What the card the address bar's Web mark opens marks as this site, read after a real click on the mark; the mark is clicked again to close it. */
export async function readMarkCard (app: ElectronApplication): Promise<{ marked: string[], tags: string[], noteMarked: boolean, label: string, closed: boolean }> {
  const chrome = findChrome(app)
  const label = await chrome.evaluate(() => document.querySelector('#web3-mark')?.getAttribute('aria-label') ?? '')
  await chrome.click('#web3-mark')
  if (!await waitFor(async () => await popoverShown(app, 'overlay=web3-score'), 5_000)) throw new Error('the Web3 Score card did not open from the mark')
  const card = cardPage(app)!
  await card.waitForSelector('.ws-level')
  if (!await waitFor(async () => (await card.$$('.ws-level.ws-here')).length > 0, 5_000)) throw new Error('the card marks no level as this site')
  const read = await card.evaluate(() => ({
    marked: Array.from(document.querySelectorAll('.ws-level.ws-here .ws-level-name'), (el) => el.textContent ?? ''),
    tags: Array.from(document.querySelectorAll('.ws-here-tag'), (el) => el.textContent ?? ''),
    noteMarked: document.querySelector('.ws-note')?.classList.contains('ws-here') === true
  }))
  await chrome.click('#web3-mark')
  const closed = await waitFor(async () => !(await popoverShown(app, 'overlay=web3-score')), 5_000)
  // Past the host's reopen debounce, so the next click reads as a fresh open.
  await chrome.waitForTimeout(400)
  return { ...read, label, closed }
}
