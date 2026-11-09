// A site on the web shown in a <webview> talks to its app and is talked to by it (ADR-0039), against the real shell and
// the real broker. The app holds `web.embed` for one https origin that is not an address on this computer: a made-up
// host name that the launch maps to a server of this file, with a certificate Chromium is told to trust by its key
// (`--ignore-certificate-errors-spki-list`), so the page is a cross-origin https document as any site is. The app sets
// an embed script that gives the page a way to reach its host, the way an app that shows third-party tools does, and
// the three things such an app counts on are read off the element: a message the page sends arrives as an
// `ipc-message` event with the channel and the arguments, `getURL()` and `getWebContentsId()` answer for the shown
// page, and `contentWindow.postMessage` reaches the page, which answers over the same bridge.
//
// An exact origin is not resolved by the grant, so the name may map to loopback here; the `"*"` form refuses a name
// that resolves to loopback (e2e-embed.test.ts, A286), which is why this file names the origin and not `"*"`.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/capabilities/e2e-embed-remote.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import type { Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { appManifest, grantApp, pageCall, startAppServer } from '../app-behaviours/app-behaviour-support.js'
import type { AppServer } from '../app-behaviours/app-behaviour-support.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { launchShell, visit } from '../support/qa-helpers.js'
import { selfSigned } from '../support/self-signed.js'

/** A name no DNS server knows: the launch maps it to loopback for Chromium alone. */
const REMOTE_HOST = 'live-app.embed-remote.test'
const TEST_TIMEOUT_MS = 120_000

/** What the app sets as its embed script: the page's one way to reach its host. */
const EMBED_SCRIPT = "window.hostBridge = { postMessage: function (message) { orivonEmbed.sendToHost('from-page', message) } }"

/** The shown site's own script: says it is ready, and answers every message its host posts to it. */
const PAGE_SCRIPT = `
window.addEventListener('message', function (event) {
  hostBridge.postMessage({ type: 'answer', received: event.data, from: event.origin, pageOrigin: location.origin, secure: isSecureContext })
})
hostBridge.postMessage({ type: 'ready', href: location.href, nested: { list: [1, 2, 3] } })
`

let dir: string
let remote: Server
let remoteOrigin = ''
/** The requests the remote server saw: the Host header and the path. */
const requests: string[] = []
let appServer: AppServer
let app: ElectronApplication
let chrome: Page
let view: Page

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-embed-remote-'))
  const tls = selfSigned(dir, [REMOTE_HOST])
  remote = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
    requests.push(`${request.headers.host ?? ''}${request.url ?? ''}`)
    if (request.url === '/live.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(PAGE_SCRIPT)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end('<!doctype html><html><head><title>remote site</title></head><body><script src="/live.js"></script></body></html>')
  })
  remote.on('tlsClientError', () => {})
  await new Promise<void>((resolve) => { remote.listen(0, '127.0.0.1', resolve) })
  remoteOrigin = `https://${REMOTE_HOST}:${String((remote.address() as AddressInfo).port)}`
  appServer = await startAppServer()

  const launched = await launchShell({
    args: [
      `--host-resolver-rules=MAP ${REMOTE_HOST} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
      `--ignore-certificate-errors-spki-list=${tls.spki}`
    ]
  })
  app = launched.app
  chrome = launched.chrome
  await grantApp(app, appServer.origin, appManifest('webview-remote', { web: { embed: { origins: [remoteOrigin] } } }), [{ capability: 'web.embed', patterns: [remoteOrigin] }])
  view = await visit(app, chrome, `${appServer.origin}/`)
}, TEST_TIMEOUT_MS)

afterAll(async () => {
  if (app !== undefined) await app.close().catch(() => {})
  if (appServer !== undefined) await appServer.close()
  if (remote !== undefined) await new Promise<void>((resolve) => { remote.close(() => { resolve() }); remote.closeAllConnections() })
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Message { readonly channel: string, readonly args: readonly unknown[] }
interface Shown { readonly messages: readonly Message[], readonly url: string, readonly id: number }
interface Answered { readonly reply: Message | null, readonly hasContentWindow: boolean }

it('[app:webview-remote-site-talks-to-the-app] a page shown from a granted https site in a <webview> reaches its app with an ipc-message carrying the channel and the arguments, the element answers getURL and getWebContentsId for it, and contentWindow.postMessage reaches the page, which answers', async () => {
  // ---- (1) the app sets its script and shows the site; the page's message arrives on the element.
  const shown = await pageCall(appServer, view, async (siteUrl: string, script: string): Promise<Shown> => {
    interface Guest extends HTMLElement { getURL: () => string, getWebContentsId: () => number }
    const orivon = (window as unknown as { orivon: { web: { setEmbedScript: (source: string) => Promise<void> } } }).orivon
    await orivon.web.setEmbedScript(script)
    const el = document.createElement('webview') as Guest
    const messages: Message[] = []
    el.addEventListener('ipc-message', (event) => {
      const { channel, args } = event as unknown as Message
      messages.push({ channel, args })
    })
    ;(window as unknown as { __shown: { el: Guest, messages: Message[] } }).__shown = { el, messages }
    el.setAttribute('src', siteUrl)
    el.style.width = '400px'
    el.style.height = '300px'
    document.body.appendChild(el)
    const deadline = Date.now() + 30_000
    while (!messages.some((m) => m.channel === 'from-page') && Date.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, 50) })
    return { messages: messages.slice(), url: el.getURL(), id: el.getWebContentsId() }
  }, `${remoteOrigin}/`, EMBED_SCRIPT)

  expect(requests.filter((r) => r.startsWith(`${REMOTE_HOST}:`)), 'the page came from the remote server, by its name, over TLS').toContain(`${new URL(remoteOrigin).host}/`)
  expect(shown.messages, 'one message, on the channel the embed script named').toEqual([{
    channel: 'from-page',
    args: [{ type: 'ready', href: `${remoteOrigin}/`, nested: { list: [1, 2, 3] } }]
  }])
  expect(shown.url, 'getURL names the shown page').toBe(`${remoteOrigin}/`)
  expect(Number.isInteger(shown.id) && shown.id > 0, `getWebContentsId answers with an id (${String(shown.id)})`).toBe(true)
  const guest = await app.evaluate(({ webContents }, id: number) => {
    const contents = webContents.fromId(id)
    return contents === undefined ? null : { type: contents.getType(), url: contents.getURL() }
  }, shown.id)
  expect(guest, 'the id is the shown page\'s web contents').toEqual({ type: 'webview', url: `${remoteOrigin}/` })

  // ---- (2) the app posts to the page through contentWindow; the page answers over the bridge.
  const answered = await pageCall(appServer, view, async (): Promise<Answered> => {
    const { el, messages } = (window as unknown as { __shown: { el: HTMLElement & { contentWindow?: { postMessage: (data: unknown, target: string) => void } }, messages: Message[] } }).__shown
    const hasContentWindow = typeof el.contentWindow?.postMessage === 'function'
    if (!hasContentWindow) return { reply: null, hasContentWindow }
    el.contentWindow?.postMessage({ ping: 7 }, '*')
    const deadline = Date.now() + 15_000
    for (;;) {
      const found = messages.find((m) => (m.args[0] as { type?: string } | undefined)?.type === 'answer')
      if (found !== undefined) return { reply: found, hasContentWindow }
      if (Date.now() >= deadline) return { reply: null, hasContentWindow }
      await new Promise((resolve) => { setTimeout(resolve, 50) })
    }
  })
  expect(answered.hasContentWindow, 'the element has a contentWindow with postMessage').toBe(true)
  expect(answered.reply, 'the page answered what its host posted, from the host\'s origin, in its own secure https origin').toEqual({
    channel: 'from-page',
    args: [{ type: 'answer', received: { ping: 7 }, from: appServer.origin, pageOrigin: remoteOrigin, secure: true }]
  })
}, TEST_TIMEOUT_MS)
