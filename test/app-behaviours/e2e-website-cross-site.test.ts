// What a website counts on when it works with a page of another site: a popup it opens on that site keeps the
// link back to it, a frame it sandboxes runs the page it serves with an origin of its own, and what it keeps in
// IndexedDB is there after a restart. Two loopback sites, two origins, no manifest anywhere: ordinary websites
// in the shared session. A wiki whose pen hands its pages to an editor on another name is the shape that needs all
// three (DecentraWiki, in orivon-ports). When the other site is an app Orivon holds, the popup is a tab of the
// app with no link back, and what the website hands over has to travel in the address it opens.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-website-cross-site.test.ts
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { appManifest, grantApp, startAppServer, type AppServer } from './app-behaviour-support.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron, profileDirOf } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { tabViews } from '../support/smoke-helpers.mjs'

/** What `read` finds once it finds something, polled until `timeoutMs`; the suite's `waitFor` answers only true or false. */
async function found<T> (read: () => Promise<T | false | null | undefined> | T | false | null | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== false && value !== null && value !== undefined) return value
    if (Date.now() >= deadline) throw new Error('timed out waiting for the page')
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

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
/**
 * A sandboxed frame of the site's own page: it looks for what the site keeps in IndexedDB, reports the origin it
 * runs as (the document's, `self.origin`: `location.origin` is the address's) and what it found, then answers
 * every message from its parent.
 */
const FRAME_SCRIPT = `const evaluated = (() => { try { return new Function('return 7')() } catch (error) { return 'refused: ' + error.name } })()
const report = (storage) => parent.postMessage({ type: 'hello', origin: self.origin, storage, evaluated }, '*')
try {
  const open = indexedDB.open('site-secret', 1)
  open.onupgradeneeded = () => { open.result.createObjectStore('kv') }
  open.onerror = () => report('refused: ' + (open.error && open.error.name))
  open.onsuccess = () => {
    try {
      const get = open.result.transaction('kv').objectStore('kv').get('secret')
      get.onsuccess = () => report(get.result === undefined ? 'empty' : 'read: ' + get.result)
      get.onerror = () => report('refused')
    } catch (error) { report('refused: ' + error.name) }
  }
} catch (error) { report('refused: ' + error.name) }
window.addEventListener('message', (event) => {
  if (event.source === parent) parent.postMessage({ type: 'echo', data: event.data }, '*')
})
`
/** The site keeps a secret in IndexedDB, then opens its sandboxed frame. */
const HOST_SCRIPT = `window.frameLog = []
const open = indexedDB.open('site-secret', 1)
open.onupgradeneeded = () => { open.result.createObjectStore('kv') }
open.onsuccess = () => {
  const tx = open.result.transaction('kv', 'readwrite')
  tx.objectStore('kv').put('kept by the site', 'secret')
  tx.oncomplete = () => {
    open.result.close()
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.src = '/frame.html'
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow) return
      window.frameLog.push(event.data)
      if (event.data.type === 'hello') frame.contentWindow.postMessage({ ping: 7 }, '*')
    })
    document.body.append(frame)
  }
}
`

/** The app's page: what address it was opened at, and whether it runs as the app. */
const ARRIVAL_SCRIPT = `window.arrived = { hash: location.hash, hadOpener: window.opener !== null, orivon: typeof window.orivon }
`

let opener: AppServer
let other: AppServer
let appSite: AppServer
beforeAll(async () => {
  opener = await startAppServer({
    '/': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>opener</title><body><button id="open">open</button><script src="/opener.js"></script>' },
    '/opener.js': { type: 'text/javascript', body: OPENER_SCRIPT },
    '/host': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>host</title><body><script src="/host.js"></script>' },
    '/host.js': { type: 'text/javascript', body: HOST_SCRIPT },
    '/frame.html': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>frame</title><script src="/frame.js"></script>' },
    '/frame.js': { type: 'text/javascript', body: FRAME_SCRIPT },
    '/store': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>store</title><body>store</body>' }
  })
  other = await startAppServer({
    '/receiver': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>receiver</title><body>receiver</body><script src="/receiver.js"></script>' },
    '/receiver.js': { type: 'text/javascript', body: RECEIVER_SCRIPT }
  })
  appSite = await startAppServer({
    '/receive': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>app</title><body>app</body><script src="/arrival.js"></script>' },
    '/arrival.js': { type: 'text/javascript', body: ARRIVAL_SCRIPT },
    '/host': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>host</title><body><script src="/host.js"></script>' },
    '/host.js': { type: 'text/javascript', body: HOST_SCRIPT },
    '/frame.html': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>frame</title><script src="/frame.js"></script>' },
    '/frame.js': { type: 'text/javascript', body: FRAME_SCRIPT }
  })
})
afterAll(async () => {
  await opener.close()
  await other.close()
  await appSite.close()
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
      const receiver = await found(() => (tabViews(first.app, first.chrome) as Page[]).find((view) => view.url() === `${other.origin}/receiver`))
      const received = await found(async () => await receiver.evaluate(() => (window as unknown as { received: unknown }).received).catch(() => null))
      check('[app:website-popup-to-another-site-keeps-opener] the popup on the other site has window.opener', await receiver.evaluate(() => (window as unknown as { hadOpener: boolean }).hadOpener))
      expect(received).toEqual({ from: opener.origin, payload: PAYLOAD })
      const log = await found(async () => {
        const entries = await page.evaluate(() => (window as unknown as { log: { type?: string }[] }).log)
        return entries.some((entry) => entry.type === 'received') ? entries : false
      })
      expect(log).toEqual([{ opened: true }, { from: other.origin, type: 'ready' }, { from: other.origin, type: 'received' }])

      const host = await visit(first.app, first.chrome, `${opener.origin}/host`)
      const frameLog = await found(async () => {
        const entries = await host.evaluate(() => (window as unknown as { frameLog: { type: string }[] }).frameLog)
        return entries.length >= 2 ? entries : false
      })
      const hello = frameLog[0] as { type?: string, origin?: string, storage?: string } | undefined
      check('[app:website-sandboxed-frame-runs-served-script] the sandboxed frame ran its served script with an opaque origin, and could not read what the site keeps in IndexedDB',
        hello?.type === 'hello' && hello.origin === 'null' && !String(hello.storage).startsWith('read:'), JSON.stringify(hello))
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

it('[app:website-popup-to-app-keeps-the-address] [app:app-sandboxed-frame-runs-served-script] a website\'s popup of an app\'s page opens the app at the whole address the website named, and the app\'s sandboxed frame runs its pages', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('a website opens a page of an app', async (check) => {
      await grantApp(app, appSite.origin, appManifest('popup-target', { net: { tcp: { connect: ['127.0.0.1:9'] } } }), [{ capability: 'tcp.connect', patterns: ['127.0.0.1:9'] }])
      // What a pen sends: a nonce and a compressed wiki, in the fragment, far longer than a short link.
      const fragment = `#/receive/${'n'.repeat(22)}/${'w'.repeat(60_000)}`
      const page = await visit(app, chrome, `${opener.origin}/`)
      await page.evaluate((target) => { (document.getElementById('open') as HTMLElement).dataset['target'] = target }, `${appSite.origin}/receive${fragment}`)
      await page.click('#open')
      const view = await found(() => (tabViews(app, chrome) as Page[]).find((v) => v.url().startsWith(`${appSite.origin}/receive`)))
      const arrived = await found(async () => await view.evaluate(() => (window as unknown as { arrived: { hash: string, hadOpener: boolean, orivon: string } }).arrived).catch(() => null))
      check('[app:website-popup-to-app-keeps-the-address] the app\'s tab opened at the whole address, fragment included', arrived.hash === fragment, `${String(arrived.hash.length)} characters`)
      check('the tab runs as the app, and has no link back to the website', arrived.orivon === 'object' && !arrived.hadOpener, JSON.stringify({ orivon: arrived.orivon, hadOpener: arrived.hadOpener }))

      const host = await visit(app, chrome, `${appSite.origin}/host`)
      const frameLog = await found(async () => {
        const entries = await host.evaluate(() => (window as unknown as { frameLog: { type: string }[] }).frameLog)
        return entries.length >= 2 ? entries : false
      })
      const hello = frameLog[0] as { type?: string, origin?: string, storage?: string, evaluated?: unknown } | undefined
      check('[app:app-sandboxed-frame-runs-served-script] the app\'s sandboxed frame ran its served script, new Function included, with an opaque origin, and could not read what the app keeps in IndexedDB',
        hello?.type === 'hello' && hello.origin === 'null' && hello.evaluated === 7 && !String(hello.storage).startsWith('read:'), JSON.stringify(hello))
      expect(frameLog[1]).toEqual({ type: 'echo', data: { ping: 7 } })
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
