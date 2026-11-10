// What the name-relay spec shares: a fake DNS-over-HTTPS server and the websites it names the addresses of, served over TLS and
// over plain http on this computer, a certificate Chromium is told to trust, the Settings toggle, and the reading of
// `orivon://report` for the relay's own fact. The proxy that carries every connection is `startLoggingProxy`'s.
import { createHash, X509Certificate } from 'node:crypto'
import { createServer as createHttp } from 'node:http'
import type { Server as HttpServer } from 'node:http'
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
  close: () => Promise<void>
}

const pageOf = (title: string, head = ''): string => `<!doctype html><meta charset="utf-8"><title>${title}</title>${head}<body>${title}</body>`

/** A 1x1 PNG. */
const ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/**
 * A website that answers every request with a page titled `title` and the path asked for (so a visit shows which request it was), over TLS when given a certificate and over plain http when not.
 * With `iconHost`, the page at `/on` names an icon on that other host, and a request for `/icon.png` there is answered with an image.
 */
export async function startFakeSite (title: string, tls?: { key: string, cert: string }, iconHost?: string): Promise<FakeSite> {
  const hosts: string[] = []
  const sockets = new Set<Socket>()
  const handler = (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): void => {
    hosts.push(request.headers.host ?? '')
    if (iconHost !== undefined && request.headers.host === iconHost && request.url === '/icon.png') { response.writeHead(200, { 'content-type': 'image/png' }).end(ICON); return }
    const head = iconHost !== undefined && request.url === '/on' ? `<link rel="icon" href="https://${iconHost}/icon.png">` : ''
    response.writeHead(200, { 'content-type': 'text/html' }).end(pageOf(`${title} ${request.url ?? ''}`, head))
  }
  const server: HttpServer | TlsServer = tls === undefined ? createHttp(handler) : createTls(tls, handler)
  server.on('connection', (socket: Socket) => { sockets.add(socket); socket.on('close', () => { sockets.delete(socket) }) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    port: (server.address() as AddressInfo).port,
    hosts,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  }
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
