// What the system-proxy specs share: a forward proxy on loopback that logs every request it is asked to make, the
// environment that makes Chromium follow it as the computer's proxy, and a visit that reports what the tab showed.
import { connect, createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ElectronApplication, Page } from 'playwright'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { activeTabInfo, popoverShown, waitFor } from '../support/smoke-helpers.mjs'

/** What the proxy was asked, in order: `CONNECT host:port`, or `METHOD absolute-url` for a plain-HTTP request. */
export type ProxyLog = string[]

export interface LoggingProxy {
  readonly port: number
  readonly url: string
  readonly seen: ProxyLog
  /** Answers a plain-HTTP request for `host` (with its port, when it has one) with this page. */
  serve: (host: string, title: string) => void
  /** Carries a `CONNECT` for `host:443` to a TLS server on this computer, as a proxy that terminates TLS for a name would. */
  tunnelTo: (host: string, port: number) => void
  close: () => Promise<void>
}

/**
 * A proxy that logs what it is asked and refuses what it was not told to serve: a `CONNECT` is answered 502 unless
 * `tunnelTo` named its host, a plain-HTTP request 404 unless `serve` did.
 */
export async function startLoggingProxy (): Promise<LoggingProxy> {
  const seen: ProxyLog = []
  const pages = new Map<string, string>()
  const tunnels = new Map<string, number>()
  const sockets = new Set<import('node:net').Socket>()
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    seen.push(`${request.method ?? ''} ${request.url ?? ''}`)
    const host = request.headers.host ?? ''
    const title = pages.get(host)
    if (title === undefined) { response.writeHead(404, { 'content-type': 'text/plain' }).end('the proxy serves nothing for this'); return }
    response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body>${title}</body>`)
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => { sockets.delete(socket) }) })
  server.on('connect', (request: IncomingMessage, client) => {
    const target = request.url ?? ''
    seen.push(`CONNECT ${target}`)
    const local = tunnels.get(target.replace(/:\d+$/, ''))
    if (local === undefined) { client.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n'); return }
    const upstream = connect(local, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => { client.destroy() })
    client.on('error', () => { upstream.destroy() })
    client.on('close', () => { upstream.destroy() })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  return {
    port,
    url: `http://127.0.0.1:${String(port)}`,
    seen,
    serve: (host, title) => { pages.set(host, title) },
    tunnelTo: (host, local) => { tunnels.set(host, local) },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  }
}

/** A TCP server that counts the connections it accepts and drops them: what a TLS server sees of a client that refuses it. */
export async function startCountingListener (): Promise<{ port: number, accepted: () => number, close: () => Promise<void> }> {
  let count = 0
  const server: TcpServer = createTcpServer((socket) => { count += 1; socket.destroy() })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { port: (server.address() as AddressInfo).port, accepted: () => count, close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) } }
}

/** Every variable Chromium reads on Linux to find a proxy, in both cases. */
const PROXY_VARIABLES = ['http_proxy', 'https_proxy', 'ftp_proxy', 'all_proxy', 'no_proxy', 'auto_proxy', 'socks_server', 'socks_version']
/** What makes Chromium ask the desktop for its proxy settings instead of the environment. */
const DESKTOP_VARIABLES = ['XDG_CURRENT_DESKTOP', 'DESKTOP_SESSION', 'GNOME_DESKTOP_SESSION_ID', 'KDE_FULL_SESSION', 'KDE_SESSION_VERSION']

/** `proxy` as the environment of a launch that has the computer's proxy set the way a shell profile sets it. */
export function proxyEnvironment (proxy: string, extra: Record<string, string> = {}): Record<string, string> {
  return { http_proxy: proxy, https_proxy: proxy, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ...extra }
}

/**
 * Runs `launch` with this process's environment stripped of the desktop and of every proxy variable, so the launch
 * inherits neither the machine's desktop settings nor a stray proxy, and puts them back at once: `launchElectron` copies
 * the environment in its first synchronous step, so the strip only has to last that long.
 */
export async function launchWithoutDesktop<T> (launch: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>()
  for (const name of [...DESKTOP_VARIABLES, ...PROXY_VARIABLES, ...PROXY_VARIABLES.map((variable) => variable.toUpperCase())]) {
    saved.set(name, process.env[name])
    delete process.env[name]
  }
  const launching = launch()
  for (const [name, value] of saved) if (value !== undefined) process.env[name] = value
  return await launching
}

/** Records every main-frame and subframe load failure of every tab, with Chromium's own name for it. */
export async function recordLoadFailures (app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electron, webContents }) => {
    const sink = globalThis as { __loadFailures?: string[] }
    sink.__loadFailures = []
    const watch = (contents: Electron.WebContents): void => {
      contents.on('did-fail-load', (_event, _code, description, url, isMainFrame) => { sink.__loadFailures?.push(`${isMainFrame ? 'main' : 'sub'} ${description} ${url}`) })
    }
    for (const contents of webContents.getAllWebContents()) watch(contents)
    electron.on('web-contents-created', (_event, contents) => { watch(contents) })
  })
}

export async function loadFailures (app: ElectronApplication): Promise<string[]> {
  return await app.evaluate(() => [...((globalThis as { __loadFailures?: string[] }).__loadFailures ?? [])])
}

export interface Visit {
  /** `page` when a document with the title loaded, `error` when the load-error sheet came up, `neither` when neither did in time. */
  readonly result: 'page' | 'error' | 'neither'
  readonly title: string
  /** The sheet's name for the error (`ERR_PROXY_CONNECTION_FAILED`), empty when there was none. */
  readonly error: string
}

const sheetPage = (app: ElectronApplication): Page | undefined => app.windows().filter((w) => w.url().includes('overlay=load-error') && !w.isClosed()).at(-1)

/** Types `url` into the address bar and reports what the tab came to show: the page with `title`, or the sheet naming why not. */
export async function visitReporting (app: ElectronApplication, chrome: Page, url: string, title: string, timeoutMs = 25_000): Promise<Visit> {
  const before = (await loadFailures(app)).length
  await clickAddressBarRetrying(chrome, url)
  let found: Visit = { result: 'neither', title: '', error: '' }
  await waitFor(async () => {
    const tab = await activeTabInfo(chrome)
    if (tab.title === title) { found = { result: 'page', title: tab.title ?? '', error: '' }; return true }
    if ((await loadFailures(app)).length > before && await popoverShown(app, 'overlay=load-error')) {
      const name = await sheetPage(app)?.locator('.load-error-name').textContent({ timeout: 1_000 }).catch(() => '') ?? ''
      if (name !== '') { found = { result: 'error', title: tab.title ?? '', error: name }; return true }
    }
    return false
  }, timeoutMs)
  return found
}
