// What the name-relay spec shares: a fake DNS-over-HTTPS server and the websites it names the addresses of, served over TLS and
// over plain http on this computer, a certificate Chromium is told to trust, the Settings toggle, and the reading of
// `orivon://report` for the relay's own fact. The proxy that carries every connection is `startLoggingProxy`'s.
import { createHash, X509Certificate } from 'node:crypto'
import { createServer as createHttp } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import { createSocket } from 'node:dgram'
import { createServer as createTls } from 'node:https'
import type { Server as TlsServer } from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import * as dns from '@dnsquery/dns-packet'
import type { ElectronApplication, Page } from 'playwright'
import { createRunCertificate } from '../../src/protocols/verifier-host/serve/certificate.js'
import { waitFor } from '../support/smoke-helpers.mjs'
import { expect } from 'vitest'

/** A certificate for every name under `relay.test`, and the key hash Chromium is told to trust it by (`--ignore-certificate-errors-spki-list`). */
export function relayCertificate (): { readonly key: string, readonly cert: string, readonly spki: string } {
  const made = createRunCertificate(new Date(), 1, '*.relay.test')
  const der = new X509Certificate(made.certPem).publicKey.export({ type: 'spki', format: 'der' })
  return { key: made.keyPem, cert: made.certPem, spki: createHash('sha256').update(der).digest('base64') }
}

/** How the fake DNS server answers a name: with this address for an `A` query (an `AAAA` one gets no data), or with this response code. */
export type DohAnswer = { readonly address: string } | { readonly rcode: number }

export const NXDOMAIN = 3
export const SERVFAIL = 2

export interface FakeDoh {
  readonly port: number
  /** What was asked, in order, as `name TYPE`. */
  readonly asked: string[]
  answer: (name: string, how: DohAnswer) => void
  /** Ends every connection, so the next query opens a tunnel again. */
  dropConnections: () => void
  close: () => Promise<void>
}

const FLAGS = dns.RECURSION_DESIRED | dns.RECURSION_AVAILABLE
const SOA = { type: 'SOA', name: 'relay.test', ttl: 60, data: { mname: 'ns.relay.test', rname: 'admin.relay.test', serial: 1, refresh: 1, retry: 1, expire: 1, minimum: 60 } } as unknown as dns.Answer

/** A DNS-over-HTTPS server (RFC 8484, `POST` of a DNS message) over TLS. The proxy tunnels the provider's host to it. */
export async function startFakeDoh (tls: { key: string, cert: string }): Promise<FakeDoh> {
  const answers = new Map<string, DohAnswer>()
  const asked: string[] = []
  const sockets = new Set<Socket>()
  const server: TlsServer = createTls(tls, (request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const query = dns.decode(Buffer.concat(chunks))
      const question = query.questions?.[0]
      const name = question?.name ?? ''
      const type = question?.type ?? 'A'
      asked.push(`${name} ${type}`)
      const how = answers.get(name)
      const rcode = how !== undefined && 'rcode' in how ? how.rcode : 0
      const records = how !== undefined && 'address' in how && type === 'A' ? [{ type: 'A', name, ttl: 60, data: how.address } as unknown as dns.Answer] : []
      const message = dns.encode({ type: 'response', id: query.id ?? 0, flags: FLAGS | rcode, questions: query.questions ?? [], answers: records, authorities: records.length === 0 ? [SOA] : [] })
      response.writeHead(200, { 'content-type': 'application/dns-message' }).end(Buffer.from(message))
    })
  })
  server.on('connection', (socket) => { const raw = socket as Socket; sockets.add(raw); raw.on('close', () => { sockets.delete(raw) }) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    port: (server.address() as AddressInfo).port,
    asked,
    answer: (name, how) => { answers.set(name, how) },
    dropConnections: () => { for (const socket of sockets) socket.destroy() },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  }
}

export interface FakeSite {
  readonly port: number
  /** The `Host` header of every request, in order. */
  readonly hosts: string[]
  /** Every request as `host` and path, in order. */
  readonly requests: string[]
  close: () => Promise<void>
}

const pageOf = (title: string, head = ''): string => `<!doctype html><meta charset="utf-8"><title>${title}</title>${head}<body>${title}</body>`

/** A 1x1 PNG. */
const ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/**
 * A website that answers every request with a page titled `title` and the path asked for (so a visit shows which request it was), over TLS when given a certificate and over plain http when not.
 * With `iconHost`, the page at `/on` names an icon on that other host, and a request for `/icon.png` there is answered with an image.
 * With `appHost`, the page at `/` of that host names a manifest (the hint an app's site gives), and the manifest is not there.
 */
export async function startFakeSite (title: string, tls?: { key: string, cert: string }, iconHost?: string, appHost?: string): Promise<FakeSite> {
  const hosts: string[] = []
  const requests: string[] = []
  const sockets = new Set<Socket>()
  const handler = (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): void => {
    hosts.push(request.headers.host ?? '')
    requests.push(`${request.headers.host ?? ''}${request.url ?? ''}`)
    if (iconHost !== undefined && request.headers.host === iconHost && request.url === '/icon.png') { response.writeHead(200, { 'content-type': 'image/png' }).end(ICON); return }
    if (appHost !== undefined && request.headers.host === appHost && request.url === '/.well-known/orivon.json') { response.writeHead(404, { 'content-type': 'text/plain' }).end('no manifest'); return }
    const hint = appHost !== undefined && request.headers.host === appHost && request.url === '/' ? '<link rel="orivon-manifest" href="/.well-known/orivon.json">' : ''
    const head = `${hint}${iconHost !== undefined && request.url === '/on' ? `<link rel="icon" href="https://${iconHost}/icon.png">` : ''}`
    response.writeHead(200, { 'content-type': 'text/html' }).end(pageOf(`${title} ${request.url ?? ''}`, head))
  }
  const server: HttpServer | TlsServer = tls === undefined ? createHttp(handler) : createTls(tls, handler)
  server.on('connection', (socket: Socket) => { sockets.add(socket); socket.on('close', () => { sockets.delete(socket) }) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    port: (server.address() as AddressInfo).port,
    hosts,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  }
}

export interface FakeStun {
  readonly port: number
  /** The address and port each datagram came from, in order. */
  readonly requests: string[]
  close: () => Promise<void>
}

/** A STUN server (RFC 8489) on loopback that answers every binding request with the address it came from, so a peer connection that reaches it gathers a server-reflexive candidate. */
export async function startFakeStun (): Promise<FakeStun> {
  const socket = createSocket('udp4')
  const requests: string[] = []
  socket.on('message', (message, remote) => {
    requests.push(`${remote.address}:${String(remote.port)}`)
    if (message.length < 20 || message.readUInt16BE(0) !== 0x0001) return
    const answer = Buffer.alloc(32)
    answer.writeUInt16BE(0x0101, 0)
    answer.writeUInt16BE(12, 2)
    message.copy(answer, 4, 4, 20)
    answer.writeUInt16BE(0x0020, 20)
    answer.writeUInt16BE(8, 22)
    answer.writeUInt8(1, 25)
    answer.writeUInt16BE(remote.port ^ 0x2112, 26)
    const cookie = [0x21, 0x12, 0xa4, 0x42]
    remote.address.split('.').forEach((part, index) => { answer.writeUInt8(Number(part) ^ (cookie[index] ?? 0), 28 + index) })
    socket.send(answer, remote.port, remote.address)
  })
  socket.on('error', () => {})
  await new Promise<void>((resolve) => { socket.bind(0, '127.0.0.1', resolve) })
  return { port: socket.address().port, requests, close: async () => { await new Promise<void>((resolve) => { socket.close(() => { resolve() }) }) } }
}

/** The ICE candidates a peer connection gathers in the tab showing `fragment`, with `stunPort`'s server named, in the page's own world: one line each (`candidate:... typ host ...`). */
export async function gatherCandidates (app: ElectronApplication, fragment: string, stunPort: number): Promise<string[]> {
  return await app.evaluate(async ({ webContents }, args) => {
    const contents = webContents.getAllWebContents().find((one) => !one.isDestroyed() && one.getURL().includes(args.fragment))
    if (contents === undefined) throw new Error(`no tab shows ${args.fragment}`)
    return await contents.executeJavaScript(`new Promise((resolve) => {
      const found = []
      const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${String(args.stunPort)}' }] })
      const done = () => { peer.close(); resolve(found) }
      peer.onicecandidate = (event) => { if (event.candidate) found.push(event.candidate.candidate); else done() }
      setTimeout(done, 8000)
      peer.createDataChannel('probe')
      peer.createOffer().then((offer) => peer.setLocalDescription(offer))
    })`) as string[]
  }, { fragment, stunPort })
}

/** Starts a peer connection in the tab showing `fragment` and keeps it on the page's window, which a page that is loaded again does not have. */
export async function keepPeerConnection (app: ElectronApplication, fragment: string): Promise<void> {
  await app.evaluate(async ({ webContents }, target) => {
    const contents = webContents.getAllWebContents().find((one) => !one.isDestroyed() && one.getURL().includes(target))
    if (contents === undefined) throw new Error(`no tab shows ${target}`)
    await contents.executeJavaScript('window.__keptPeer = new RTCPeerConnection(); true')
  }, fragment)
}

/** Whether the tab showing `fragment` still holds the peer connection `keepPeerConnection` made: false once the page was loaded again, undefined while no tab shows it. */
export async function holdsKeptPeer (app: ElectronApplication, fragment: string): Promise<boolean | undefined> {
  return await app.evaluate(async ({ webContents }, target) => {
    const contents = webContents.getAllWebContents().find((one) => !one.isDestroyed() && one.getURL().includes(target) && !one.isLoading())
    if (contents === undefined) return undefined
    return await contents.executeJavaScript('typeof window.__keptPeer !== "undefined"') as boolean
  }, fragment)
}

/** Opens Settings, Privacy and network, and makes the switch's checkbox `on`. The row is the one the person sees, so a change here is the same as theirs. */
export async function setRelaySwitch (app: ElectronApplication, chrome: Page, on: boolean): Promise<void> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/privacy') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings') && !w.isClosed()))).toBe(true)
  const page = app.windows().filter((w) => w.url().startsWith('orivon://settings') && !w.isClosed()).at(-1) as Page
  const box = page.locator('#row-resolve-behind-proxy input[type=checkbox]')
  await box.waitFor({ timeout: 15_000 })
  if (await box.isChecked() !== on) await box.click()
  expect(await waitFor(async () => await box.isChecked() === on)).toBe(true)
}

export interface RelayFact {
  readonly state: string
  readonly provider: string
  readonly resolver: string
  readonly refused: Readonly<Record<string, number>>
}

/** Opens `orivon://report` and reads the relay's fact, the log lines it wrote and the whole preview text, once main has built the preview; a report that is already open is read again. */
export async function reportedRelay (app: ElectronApplication, chrome: Page, wanted: (fact: RelayFact) => boolean = () => true): Promise<{ fact: RelayFact | undefined, lines: string[], text: string }> {
  const reports = (): Page[] => app.windows().filter((w) => w.url().startsWith('orivon://report') && !w.isClosed())
  const open = reports().at(-1)
  if (open === undefined) {
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('report.open') })
    expect(await waitFor(() => reports().length > 0)).toBe(true)
  } else {
    await open.reload()
  }
  const page = reports().at(-1) as Page
  await page.waitForSelector('#report-what')
  let text = ''
  let fact: RelayFact | undefined
  let lines: string[] = []
  await waitFor(async () => {
    text = await page.locator('#report-preview').textContent() ?? ''
    try {
      const shown = JSON.parse(text === '' ? '{}' : text) as { log?: string[] | null, diagnostics?: { browser?: { nameRelay?: RelayFact } } }
      fact = shown.diagnostics?.browser?.nameRelay
      lines = (shown.log ?? []).filter((line) => line.includes('[route] name relay')).map((line) => line.slice(line.indexOf('[route]')))
    } catch { fact = undefined }
    return fact !== undefined && wanted(fact)
  }, 15_000)
  return { fact, lines, text }
}

/** Waits until `count` has stopped growing for a second (at most twenty), so a connection a finished page still makes is not read as the next step's. */
export async function quiet (count: () => number): Promise<void> {
  let last = -1
  for (let i = 0; i < 20 && count() !== last; i++) {
    last = count()
    await new Promise<void>((resolve) => { setTimeout(resolve, 1000) })
  }
}
