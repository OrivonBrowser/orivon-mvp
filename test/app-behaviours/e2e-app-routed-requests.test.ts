// What an app's own `fetch` and `XMLHttpRequest` can count on once the host is granted, seen from a loopback server
// that records what reaches it: no Origin or Referer unless the app sets one, a body that arrives in pieces while the
// server is still sending, a binary PUT that a later GET returns byte for byte (the server sends no CORS header), a
// FormData and a File body on the wire, redirects followed up to a bound, and the two spellings of a loopback grant.
// One launch. Every check carries the id of the behaviour it protects (test/app-behaviours/catalogue.md).
//
// The page is a bare loopback origin made an app by the developer-only grant, so the e2e build is required:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-routed-requests.test.ts
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { appManifest, grantApp, pageCall, startAppServer } from './app-behaviour-support.js'
import type { AppServer } from './app-behaviour-support.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay } from '../support/smoke-helpers.mjs'

interface Seen { readonly method: string, readonly url: string, readonly headers: IncomingMessage['headers'], readonly body: Buffer }

/** The bytes the page and this file both derive: every byte value, in an order that repeats only after 251 steps. */
function sample (length: number): Buffer {
  const bytes = Buffer.alloc(length)
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) % 256
  return bytes
}

const seen: Seen[] = []
/** What a PUT stored, by path. Neither it nor any answer carries a CORS header. */
const stored = new Map<string, { type: string, bytes: Buffer }>()
/** The response left open by `/stream` until the page asks `/continue`. */
let streaming: ServerResponse | undefined
let granted: Server
let grantedPort = 0
let neighbour: Server
let neighbourPort = 0
let neighbourHits = 0
let app: ElectronApplication
let chrome: Page
let appServer: AppServer
let view: Page

function handle (request: IncomingMessage, response: ServerResponse): void {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
  request.on('end', () => {
    const body = Buffer.concat(chunks)
    const url = request.url ?? '/'
    const path = url.split('?')[0] ?? '/'
    const method = request.method ?? 'GET'
    seen.push({ method, url, headers: request.headers, body })
    if (path === '/echo') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ headers: request.headers }))
    } else if (path.startsWith('/files/') && method === 'PUT') {
      stored.set(path, { type: request.headers['content-type'] ?? '', bytes: body })
      response.writeHead(201, { 'content-type': 'text/plain' })
      response.end('stored')
    } else if (path.startsWith('/files/')) {
      const file = stored.get(path)
      if (file === undefined) { response.writeHead(404); response.end(); return }
      response.writeHead(200, { 'content-type': file.type === '' ? 'application/octet-stream' : file.type })
      response.end(file.bytes)
    } else if (path === '/sink') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('received')
    } else if (path === '/stream') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('first\n')
      streaming = response
    } else if (path === '/continue') {
      streaming?.write('second\n')
      streaming?.end('third\n')
      streaming = undefined
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('continued')
    } else if (path === '/r/1' || path === '/r/2') {
      response.writeHead(302, { location: path === '/r/1' ? '/r/2' : '/landed' })
      response.end()
    } else if (path === '/landed') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('landed')
    } else if (path.startsWith('/chain/')) {
      const left = Number(path.slice('/chain/'.length))
      if (left > 0) { response.writeHead(302, { location: `/chain/${String(left - 1)}` }); response.end() } else { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('end of chain') }
    } else {
      response.writeHead(404)
      response.end()
    }
  })
}

beforeAll(async () => {
  granted = createServer(handle)
  neighbour = createServer((_request, response) => { neighbourHits += 1; response.writeHead(200); response.end('neighbour') })
  for (const server of [granted, neighbour]) await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  grantedPort = (granted.address() as AddressInfo).port
  neighbourPort = (neighbour.address() as AddressInfo).port
  appServer = await startAppServer()
  const launched = await launchShell()
  app = launched.app
  chrome = launched.chrome
  // The grant names the host `localhost`; the page then calls it by that name and by the loopback address.
  const pattern = `localhost:${String(grantedPort)}`
  await grantApp(app, appServer.origin, appManifest('routed-requests', { net: { tcp: { connect: [pattern] } } }), [{ capability: 'tcp.connect', patterns: [pattern] }])
  view = await visit(app, chrome, `${appServer.origin}/`)
}, 180_000)

afterAll(async () => {
  if (app !== undefined) await closeElectron(app)
  await appServer?.close()
  streaming?.destroy()
  for (const server of [granted, neighbour]) await new Promise<void>((resolve) => { server?.close(() => { resolve() }); server?.closeAllConnections() })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const base = (host: string): string => `http://${host}:${String(grantedPort)}`

it('[app:routed-fetch-sends-no-origin-by-default] a routed fetch sends no Origin or Referer unless the app sets one, and sends the Cookie and Origin it does set', async () => {
  const outcome = await pageCall(appServer, view, async (url: string) => {
    const plain = await (await fetch(`${url}/echo`)).json() as { headers: Record<string, string> }
    const set = await (await fetch(`${url}/echo`, { headers: { Origin: 'https://set-by-the-app.example', Cookie: 'sid=app-managed' } })).json() as { headers: Record<string, string> }
    return { plain: plain.headers, set: set.headers }
  }, base('localhost'))
  expect(outcome.plain.origin, 'no Origin the app did not set').toBeUndefined()
  expect(outcome.plain.referer, 'no Referer the app did not set').toBeUndefined()
  expect(outcome.set.origin, 'the app\'s own Origin').toBe('https://set-by-the-app.example')
  expect(outcome.set.cookie, 'the app\'s own Cookie').toBe('sid=app-managed')
  expect(outcome.set.referer, 'still no Referer').toBeUndefined()
}, QA_TEST_TIMEOUT_MS)

it('[app:routed-fetch-delivers-body-in-pieces] a routed fetch hands the page the first chunk of a chunked body while the server is still sending, and the stream ends when the server ends it', async () => {
  const outcome = await pageCall(appServer, view, async (url: string) => {
    const response = await fetch(`${url}/stream`)
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    const early = await Promise.race([reader.read(), new Promise<'nothing yet'>((resolve) => { setTimeout(() => { resolve('nothing yet') }, 15_000) })])
    if (early === 'nothing yet') return { first: early, rest: '', done: false }
    // The server holds back the rest until this request reaches it, so the first read cannot have waited for the end.
    await fetch(`${url}/continue`)
    let rest = ''
    for (;;) {
      const next = await reader.read()
      if (next.done) return { first: decoder.decode(early.value), rest, done: true }
      rest += decoder.decode(next.value)
    }
  }, base('localhost'))
  expect(outcome.first, 'the first chunk, before the server was told to go on').toBe('first\n')
  expect(outcome.rest, 'the chunks that followed').toBe('second\nthird\n')
  expect(outcome.done, 'the final read reports done').toBe(true)
}, QA_TEST_TIMEOUT_MS)

it('[app:routed-xhr-puts-binary-body-without-cors] a routed XMLHttpRequest PUT of a Blob or an ArrayBuffer to a host that sends no CORS header ends 2xx, the server holds the exact bytes, and a later routed fetch returns them', async () => {
  const outcome = await pageCall(appServer, view, async (url: string) => {
    const make = (length: number): Uint8Array => { const bytes = new Uint8Array(length); for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) % 256; return bytes }
    const put = async (path: string, body: Blob | ArrayBuffer, type: string): Promise<number> => await new Promise<number>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', `${url}${path}`)
      xhr.setRequestHeader('Content-Type', type)
      xhr.onload = () => { resolve(xhr.status) }
      xhr.onerror = () => { reject(new Error('xhr error')) }
      xhr.send(body)
    })
    const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, i) => value === b[i])
    const bytes = make(200_000)
    const blobStatus = await put('/files/blob.bin', new Blob([bytes.slice().buffer]), 'application/octet-stream')
    const bufferStatus = await put('/files/buffer.bin', bytes.slice().buffer, 'application/octet-stream')
    const blobBack = new Uint8Array(await (await fetch(`${url}/files/blob.bin`)).arrayBuffer())
    const bufferBack = new Uint8Array(await (await fetch(`${url}/files/buffer.bin`)).arrayBuffer())
    return { blobStatus, bufferStatus, blobSame: equal(blobBack, bytes), bufferSame: equal(bufferBack, bytes) }
  }, base('localhost'))
  expect(outcome.blobStatus, 'the Blob PUT').toBe(201)
  expect(outcome.bufferStatus, 'the ArrayBuffer PUT').toBe(201)
  expect(stored.get('/files/blob.bin')?.bytes.equals(sample(200_000)), 'the server holds the Blob\'s bytes').toBe(true)
  expect(stored.get('/files/buffer.bin')?.bytes.equals(sample(200_000)), 'the server holds the ArrayBuffer\'s bytes').toBe(true)
  expect(outcome.blobSame, 'the Blob read back').toBe(true)
  expect(outcome.bufferSame, 'the ArrayBuffer read back').toBe(true)
}, QA_TEST_TIMEOUT_MS)

it('[app:routed-fetch-sends-formdata] a routed fetch with a FormData body sends one multipart body with the field, the file\'s name and its exact bytes, and a File body sends its bytes with the file\'s type', async () => {
  const before = seen.length
  const outcome = await pageCall(appServer, view, async (url: string) => {
    const bytes = new Uint8Array(256 + 4)
    for (let i = 0; i < 256; i++) bytes[i] = i
    bytes.set([13, 10, 45, 45], 256)
    const form = new FormData()
    form.append('note', 'hello form')
    form.append('upload', new File([bytes], 'sample.bin', { type: 'application/octet-stream' }))
    const posted = await fetch(`${url}/sink`, { method: 'POST', body: form })
    const put = await fetch(`${url}/sink`, { method: 'PUT', body: new File([bytes], 'picture.png', { type: 'image/png' }) })
    return { posted: posted.status, put: put.status }
  }, base('localhost'))
  expect(outcome, 'both answered').toEqual({ posted: 200, put: 200 })
  const [form, file] = seen.slice(before)
  const bytes = Buffer.alloc(260)
  for (let i = 0; i < 256; i++) bytes[i] = i
  bytes.set([13, 10, 45, 45], 256)
  expect(form?.headers['content-type'], 'a multipart body with a boundary').toMatch(/^multipart\/form-data; boundary=\S+$/)
  const boundary = /boundary=(\S+)$/.exec(form?.headers['content-type'] ?? '')?.[1] ?? ''
  expect(boundary).not.toBe('')
  const text = form?.body.toString('latin1') ?? ''
  expect(text, 'the text field').toContain('name="note"\r\n\r\nhello form\r\n')
  expect(text, 'the file part carries its name').toContain('name="upload"; filename="sample.bin"')
  expect(form?.body.indexOf(bytes), 'the file\'s exact bytes, in the body').toBeGreaterThan(0)
  expect(text.trimEnd().endsWith(`--${boundary}--`), 'the closing boundary').toBe(true)
  expect(file?.headers['content-type'], 'a File body keeps its type').toBe('image/png')
  expect(file?.body.equals(bytes), 'and its exact bytes').toBe(true)
}, QA_TEST_TIMEOUT_MS)

it('[app:routed-fetch-follows-redirects] a routed fetch follows a two-hop redirect and returns the final answer, and fails past the bound', async () => {
  const outcome = await pageCall(appServer, view, async (url: string) => {
    const response = await fetch(`${url}/r/1`)
    const final = { status: response.status, redirected: response.redirected, url: response.url, text: await response.text() }
    const shortChain = await (await fetch(`${url}/chain/5`)).text()
    const longChain = await fetch(`${url}/chain/40`).then(() => 'answered', (error: Error) => error.name)
    return { final, shortChain, longChain }
  }, base('localhost'))
  expect(outcome.final, 'the redirect was followed').toEqual({ status: 200, redirected: true, url: `${base('localhost')}/landed`, text: 'landed' })
  expect(outcome.shortChain, 'five hops').toBe('end of chain')
  expect(outcome.longChain, 'forty hops are past the bound').toBe('TypeError')
}, QA_TEST_TIMEOUT_MS)

it('[app:routed-fetch-loopback-grant-covers-both-spellings] a grant naming localhost:<port> is reached by a routed fetch to localhost and to 127.0.0.1 on that port, and another loopback port is not reached', async () => {
  const hitsBefore = neighbourHits
  const outcome = await pageCall(appServer, view, async (byName: string, byAddress: string, other: string) => {
    const reach = async (url: string): Promise<string> => {
      try {
        const response = await fetch(url, { headers: { Origin: 'https://set-by-the-app.example', Cookie: 'sid=1' } })
        const text = await response.text()
        let cookie = text
        try { cookie = (JSON.parse(text) as { headers: Record<string, string> }).headers.cookie ?? text } catch { /* not the echo */ }
        return `${String(response.status)} ${cookie}`
      } catch (error) {
        return `failed: ${(error as Error).name}`
      }
    }
    return { byName: await reach(`${byName}/echo`), byAddress: await reach(`${byAddress}/echo`), other: await reach(other) }
  }, base('localhost'), base('127.0.0.1'), `http://localhost:${String(neighbourPort)}/echo`)
  expect(outcome.byName, 'the name the grant uses').toBe('200 sid=1')
  expect(outcome.byAddress, 'the loopback address').toBe('200 sid=1')
  expect(outcome.other, 'a port the manifest does not name').toMatch(/^failed: /)
  await delay(ABSENCE_SETTLE_MS)
  expect(neighbourHits, 'nothing reached the other port').toBe(hitsBefore)
}, QA_TEST_TIMEOUT_MS)

