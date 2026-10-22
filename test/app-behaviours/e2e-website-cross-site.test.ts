// What a website counts on when it works with a page of another site: a popup it opens on that site keeps the
// link back to it, a frame it sandboxes runs the page it serves with an origin of its own, and what it keeps in
// IndexedDB is there after a restart. Two loopback sites, two origins, no manifest anywhere: ordinary websites
// in the shared session. A wiki whose pen hands its pages to an editor on another name is the shape that needs all
// three (DecentraWiki, in orivon-ports).
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-website-cross-site.test.ts
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { startAppServer, type AppServer } from './app-behaviour-support.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron, profileDirOf } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { tabViews, waitFor } from '../support/smoke-helpers.mjs'

const PAYLOAD = { pages: ['first', 'second'], size: 3 }

/** The opening site: a click opens the other site's receiver, which asks for the payload and confirms it. */
const OPENER_SCRIPT = `window.log = []
document.getElementById('open').addEventListener('click', () => {
  const target = document.getElementById('open').dataset.target
  const opened = window.open(target, '_blank')
  window.log.push({ opened: opened !== null })
  window.addEventListener('message', (event) => {
    if (event.source !== opened) return
    window.log.push({ from: event.origin, type: event.data && event.data.type })
    if (event.data && event.data.type === 'ready') opened.postMessage({ type: 'payload', payload: ${JSON.stringify(PAYLOAD)} }, event.origin)
  })
})
`
const RECEIVER_SCRIPT = `window.received = null
window.hadOpener = window.opener !== null
window.addEventListener('message', (event) => {
  if (event.source !== window.opener || !event.data || event.data.type !== 'payload') return
  window.received = { from: event.origin, payload: event.data.payload }
  window.opener.postMessage({ type: 'received' }, event.origin)
})
if (window.opener) window.opener.postMessage({ type: 'ready' }, '*')
`
/** A sandboxed frame of the site's own page: reports what it runs as, then answers every message from its parent. */
const FRAME_SCRIPT = `let storage
try { indexedDB.open('frame-probe'); storage = 'opened' } catch (error) { storage = error.name }
parent.postMessage({ type: 'hello', origin: location.origin, storage }, '*')
window.addEventListener('message', (event) => {
  if (event.source === parent) parent.postMessage({ type: 'echo', data: event.data }, '*')
})
`
const HOST_SCRIPT = `window.frameLog = []
const frame = document.getElementById('frame')
window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow) return
  window.frameLog.push(event.data)
  if (event.data.type === 'hello') frame.contentWindow.postMessage({ ping: 7 }, '*')
})
`

let opener: AppServer
let other: AppServer
beforeAll(async () => {
  opener = await startAppServer({
    '/': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>opener</title><body><button id="open">open</button><script src="/opener.js"></script>' },
    '/opener.js': { type: 'text/javascript', body: OPENER_SCRIPT },
    '/host': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>host</title><body><iframe id="frame" sandbox="allow-scripts" src="/frame.html"></iframe><script src="/host.js"></script>' },
    '/host.js': { type: 'text/javascript', body: HOST_SCRIPT },
    '/frame.html': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>frame</title><script src="/frame.js"></script>' },
    '/frame.js': { type: 'text/javascript', body: FRAME_SCRIPT },
    '/store': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>store</title><body>store</body>' }
  })
  other = await startAppServer({
    '/receiver': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>receiver</title><body>receiver</body><script src="/receiver.js"></script>' },
    '/receiver.js': { type: 'text/javascript', body: RECEIVER_SCRIPT }
  })
})
afterAll(async () => {
  await opener.close()
  await other.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** IndexedDB on the page, as a site's own script would use it. */
async function writeRecord (view: Page): Promise<void> {
  await view.evaluate(async () => await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('site-state', 1)
    open.onupgradeneeded = () => { open.result.createObjectStore('kv') }
    open.onerror = () => { reject(open.error) }
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', 'readwrite')
      tx.objectStore('kv').put({ note: 'kept by a website', n: 42 }, 'record')
      tx.oncomplete = () => { open.result.close(); resolve() }
      tx.onerror = () => { reject(tx.error) }
    }
  }))
}

async function readRecord (view: Page): Promise<unknown> {
  return await view.evaluate(async () => await new Promise((resolve, reject) => {
    const open = indexedDB.open('site-state', 1)
    open.onupgradeneeded = () => { open.result.createObjectStore('kv') }
    open.onerror = () => { reject(open.error) }
    open.onsuccess = () => {
      const get = open.result.transaction('kv').objectStore('kv').get('record')
      get.onsuccess = () => { open.result.close(); resolve(get.result ?? null) }
      get.onerror = () => { reject(get.error) }
    }
  }))
}

it('[app:website-popup-to-another-site-keeps-opener] [app:website-sandboxed-frame-runs-served-script] [app:website-indexeddb-survives-restart] a website works with another site\'s page and keeps its data', async () => {
  const first = await launchShell()
  const profile = profileDirOf(first.app)
  if (profile === undefined) throw new Error('the launcher did not report a profile directory')
  let live: ElectronApplication | undefined = first.app
  try {
    await runPhase('a website with another site\'s page', async (check) => {
      const page = await visit(first.app, first.chrome, `${opener.origin}/`)
      await page.evaluate((target) => { (document.getElementById('open') as HTMLElement).dataset['target'] = target }, `${other.origin}/receiver`)
      await page.click('#open')
      const receiver = await waitFor(() => (tabViews(first.app, first.chrome) as Page[]).find((view) => view.url() === `${other.origin}/receiver`) ?? false) as Page
      const received = await waitFor(async () => await receiver.evaluate(() => (window as unknown as { received: unknown }).received).catch(() => null))
      check('[app:website-popup-to-another-site-keeps-opener] the popup on the other site has window.opener', await receiver.evaluate(() => (window as unknown as { hadOpener: boolean }).hadOpener))
      expect(received).toEqual({ from: opener.origin, payload: PAYLOAD })
      const log = await waitFor(async () => {
        const entries = await page.evaluate(() => (window as unknown as { log: { type?: string }[] }).log)
        return entries.some((entry) => entry.type === 'received') ? entries : false
      })
      expect(log).toEqual([{ opened: true }, { from: other.origin, type: 'ready' }, { from: other.origin, type: 'received' }])

      const host = await visit(first.app, first.chrome, `${opener.origin}/host`)
      const frameLog = await waitFor(async () => {
        const entries = await host.evaluate(() => (window as unknown as { frameLog: { type: string }[] }).frameLog)
        return entries.length >= 2 ? entries : false
      })
      check('[app:website-sandboxed-frame-runs-served-script] the sandboxed frame ran its served script with an opaque origin and no storage', JSON.stringify(frameLog[0]) === JSON.stringify({ type: 'hello', origin: 'null', storage: 'SecurityError' }))
      expect(frameLog[1]).toEqual({ type: 'echo', data: { ping: 7 } })

      const store = await visit(first.app, first.chrome, `${opener.origin}/store`)
      await writeRecord(store)
    })
    await closeElectron(first.app, { keepProfile: true })
    live = undefined
    const second = await launchShell({ reuseProfile: profile })
    live = second.app
    await runPhase('a website\'s data after a restart', async (check) => {
      const store = await visit(second.app, second.chrome, `${opener.origin}/store`)
      check('[app:website-indexeddb-survives-restart] the record is there', JSON.stringify(await readRecord(store)) === JSON.stringify({ note: 'kept by a website', n: 42 }))
    })
  } finally {
    if (live !== undefined) await closeElectron(live)
  }
}, QA_TEST_TIMEOUT_MS * 3)
