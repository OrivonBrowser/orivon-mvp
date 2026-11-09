// What the system-proxy specs share: a forward proxy on loopback that logs every request it is asked to make, the
// environment that makes Chromium follow it as the computer's proxy, a launch of the shell with the verifier host up, and a
// visit that reports what the tab showed.
import { execFileSync } from 'node:child_process'
import { connect, type AddressInfo } from 'node:net'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { activeTabInfo, findChrome, HERMETIC_RESOLVER, popoverShown, waitFor } from '../support/smoke-helpers.mjs'

/** What the proxy was asked, in order: `CONNECT host:port`, or `METHOD absolute-url` for a plain-HTTP request. */
export type ProxyLog = string[]

export interface LoggingProxy {
  readonly port: number
  readonly url: string
  readonly seen: ProxyLog
  /** Answers a plain-HTTP request for `host` (with its port, when it has one) with a page of this title, and this body (the title, when none is given). */
  serve: (host: string, title: string, body?: string) => void
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
  const pages = new Map<string, { title: string, body: string }>()
  const tunnels = new Map<string, number>()
  const sockets = new Set<import('node:net').Socket>()
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    seen.push(`${request.method ?? ''} ${request.url ?? ''}`)
    const host = request.headers.host ?? ''
    const page = pages.get(host)
    if (page === undefined) { response.writeHead(404, { 'content-type': 'text/plain' }).end('the proxy serves nothing for this'); return }
    response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><meta charset="utf-8"><title>${page.title}</title><body>${page.body}</body>`)
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
    serve: (host, title, body = title) => { pages.set(host, { title, body }) },
    tunnelTo: (host, local) => { tunnels.set(host, local) },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  }
}

/** Every variable Chromium reads on Linux to find a proxy, in both cases. */
const PROXY_VARIABLES = ['http_proxy', 'https_proxy', 'ftp_proxy', 'all_proxy', 'no_proxy', 'auto_proxy', 'socks_server', 'socks_version']
/** What makes Chromium ask the desktop for its proxy settings instead of the environment. */
const DESKTOP_VARIABLES = ['XDG_CURRENT_DESKTOP', 'DESKTOP_SESSION', 'GNOME_DESKTOP_SESSION_ID', 'KDE_FULL_SESSION', 'KDE_SESSION_VERSION']

/** `proxy` as the environment of a launch that has the computer's proxy set the way a shell profile sets it. */
export function proxyEnvironment (proxy: string, extra: Record<string, string> = {}): Record<string, string> {
  return { http_proxy: proxy, https_proxy: proxy, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ...extra }
}

/** The schema Chromium reads GNOME's proxy through; a keyfile backend cannot answer for a schema that is not installed. */
const GNOME_PROXY_SCHEMA = '/usr/share/glib-2.0/schemas/org.gnome.system.proxy.gschema.xml'

/** The keyfile backend of the test's own, where the desktop's settings are read from, changed the way the settings window would. */
function gnomeKeyfile (dir: string): { readonly env: Record<string, string>, readonly write: (text: string) => void } {
  if (!existsSync(GNOME_PROXY_SCHEMA)) throw new Error('GNOME\'s proxy settings need the package gsettings-desktop-schemas: without it Chromium reads no proxy from the desktop, whatever this writes')
  mkdirSync(join(dir, 'glib-2.0', 'settings'), { recursive: true })
  const file = join(dir, 'glib-2.0', 'settings', 'keyfile')
  const write = (text: string): void => {
    writeFileSync(`${file}.tmp`, text)
    renameSync(`${file}.tmp`, file)
  }
  return { env: { XDG_CURRENT_DESKTOP: 'GNOME', GSETTINGS_BACKEND: 'keyfile', XDG_CONFIG_HOME: dir }, write }
}

/**
 * A computer whose desktop (GNOME's settings) carries the proxy, in a keyfile settings backend of the test's own. Chromium reads
 * a desktop's settings and only then the environment, so no `no_proxy` in the environment exempts anything on such a computer.
 * `write` changes the port the way the desktop's settings window would, `off` turns the proxy off and `script` points the desktop at a script.
 */
export function gnomeProxy (dir: string, port: number, ignore: readonly string[] = ['localhost', '127.0.0.0/8', '::1']): { env: Record<string, string>, write: (port: number) => void, off: () => void, script: (scriptUrl: string) => void } {
  const keyfile = gnomeKeyfile(dir)
  const write = (next: number): void => {
    keyfile.write(`[system/proxy]\nmode='manual'\nignore-hosts=[${ignore.map((host) => `'${host}'`).join(', ')}]\n\n[system/proxy/http]\nhost='127.0.0.1'\nport=${String(next)}\n\n[system/proxy/https]\nhost='127.0.0.1'\nport=${String(next)}\n`)
  }
  write(port)
  return {
    env: keyfile.env,
    write,
    off: () => { keyfile.write('[system/proxy]\nmode=\'none\'\n') },
    script: (scriptUrl) => { keyfile.write(`[system/proxy]\nmode='auto'\nautoconfig-url='${scriptUrl}'\nignore-hosts=['localhost', '127.0.0.0/8', '::1']\n`) }
  }
}

/** A computer whose desktop finds its proxy with a script (`mode='auto'`), which `write` points at another address the way the settings window would. */
export function gnomeScriptProxy (dir: string, scriptUrl: string): { env: Record<string, string>, write: (scriptUrl: string) => void } {
  const keyfile = gnomeKeyfile(dir)
  const write = (next: string): void => { keyfile.write(`[system/proxy]\nmode='auto'\nautoconfig-url='${next}'\nignore-hosts=['localhost', '127.0.0.0/8', '::1']\n`) }
  write(scriptUrl)
  return { env: keyfile.env, write }
}

export interface ScriptServer {
  readonly url: string
  /** The times a script was asked for. */
  readonly asked: () => number
  /** Answers every ask from now on with `script` after `delayMs`; an answer of `null` never comes. */
  serve: (script: string | null, delayMs?: number) => void
  close: () => Promise<void>
}

/** A server of proxy auto-configuration scripts: what a PAC address in the desktop's settings points at. */
export async function startScriptServer (): Promise<ScriptServer> {
  let script: string | null = 'function FindProxyForURL() { return "DIRECT" }'
  let delayMs = 0
  let asked = 0
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer((_request, response) => {
    asked += 1
    if (script === null) return
    const body = script
    const timer = setTimeout(() => { timers.delete(timer); response.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig', 'cache-control': 'no-store' }).end(body) }, delayMs)
    timers.add(timer)
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => { sockets.delete(socket) }) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/proxy.pac`,
    asked: () => asked,
    serve: (next, delay = 0) => { script = next; delayMs = delay },
    close: async () => {
      for (const timer of timers) clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  }
}

/** A script that sends the names the verifier serves where `verifierNames` says and every other host to `others`. */
export function proxyScript (verifierNames: string, others: string): string {
  return `function FindProxyForURL(url, host) { if (/\\.(eth|orivon)\\.?$/.test(host)) return ${JSON.stringify(verifierNames)}; return ${JSON.stringify(others)} }`
}

/**
 * Turns Windows' "Automatically detect settings" on for the user running this, as its settings page does and as a new
 * installation has it, and returns what puts the setting back. Chromium reads it when a session starts, so it is done before a launch.
 */
export function windowsAutoDetect (): () => void {
  const run = (script: string): string => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim()
  const settings = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  const connections = `${settings}\\Connections`
  const before = run(`$v = (Get-ItemProperty -Path '${connections}' -Name DefaultConnectionSettings -ErrorAction SilentlyContinue).DefaultConnectionSettings; if ($v) { ($v | ForEach-Object { $_.ToString() }) -join ',' }`)
  const detectBefore = run(`(Get-ItemProperty -Path '${settings}' -Name AutoDetect -ErrorAction SilentlyContinue).AutoDetect`)
  // The blob WinINET keeps: signature, change counter, flags (1 direct, 8 detect automatically), then three empty strings and 32 reserved bytes.
  run(`New-Item -Path '${connections}' -Force | Out-Null; $b = [byte[]](0x46,0,0,0, 0x21,0,0,0, 9,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0) + (New-Object byte[] 32); Set-ItemProperty -Path '${connections}' -Name DefaultConnectionSettings -Value $b -Type Binary; Set-ItemProperty -Path '${settings}' -Name AutoDetect -Value 1 -Type DWord`)
  return () => {
    if (before === '') run(`Remove-ItemProperty -Path '${connections}' -Name DefaultConnectionSettings -ErrorAction SilentlyContinue`)
    else run(`Set-ItemProperty -Path '${connections}' -Name DefaultConnectionSettings -Value ([byte[]](${before})) -Type Binary`)
    if (detectBefore === '') run(`Remove-ItemProperty -Path '${settings}' -Name AutoDetect -ErrorAction SilentlyContinue`)
    else run(`Set-ItemProperty -Path '${settings}' -Name AutoDetect -Value ${detectBefore} -Type DWord`)
  }
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
  /** What the sheet says (its heading and its sentence), empty when there was none. */
  readonly sheet: string
}

const sheetPage = (app: ElectronApplication): Page | undefined => app.windows().filter((w) => w.url().includes('overlay=load-error') && !w.isClosed()).at(-1)

/** Types `url` into the address bar and reports what the tab came to show: the page with `title`, or the sheet naming why not. */
export async function visitReporting (app: ElectronApplication, chrome: Page, url: string, title: string, timeoutMs = 25_000): Promise<Visit> {
  const before = (await loadFailures(app)).length
  await clickAddressBarRetrying(chrome, url)
  let found: Visit = { result: 'neither', title: '', error: '', sheet: '' }
  await waitFor(async () => {
    const tab = await activeTabInfo(chrome)
    if (tab.title === title) { found = { result: 'page', title: tab.title ?? '', error: '', sheet: '' }; return true }
    if ((await loadFailures(app)).length > before && await popoverShown(app, 'overlay=load-error')) {
      const sheet = sheetPage(app)
      const name = await sheet?.locator('.load-error-name').textContent({ timeout: 1_000 }).catch(() => '') ?? ''
      if (name !== '') {
        const heading = await sheet?.locator('#load-error-title').textContent({ timeout: 1_000 }).catch(() => '') ?? ''
        const sentence = await sheet?.locator('#load-error-text').textContent({ timeout: 1_000 }).catch(() => '') ?? ''
        found = { result: 'error', title: tab.title ?? '', error: name, sheet: `${heading} ${sentence}`.trim() }
        return true
      }
    }
    return false
  }, timeoutMs)
  return found
}

export const ORDINARY = 'http://ordinary.test:8080/'
export const SUBRESOURCES = 'http://subresources.test:8080/'
/** A page the proxy serves that asks for names the verifier serves in every way a page can: a picture, a script's `fetch` and WebSocket, and a hint to connect ahead. It retitles itself once its requests have ended. */
export const SUBRESOURCES_BODY = `<link rel="preconnect" href="https://pre.eth"><img src="https://img.eth/a.png"><script>
Promise.allSettled([fetch('https://fetched.eth/a'), new Promise((done) => { const socket = new WebSocket('wss://sock.eth/'); socket.onclose = socket.onerror = () => { done() } })]).then(() => { document.title = 'subresources settled' })
</script>`

/** The lines of a proxy's log that name a host the verifier serves. */
export const verifierNames = (log: readonly string[]): string[] => log.filter((line) => /\.(eth|orivon)\b/.test(line))

export interface Running { app: ElectronApplication, chrome: Page }

/** A shell whose verifier host is up, answering `fixture.eth` and `direct.eth` from `gateway`, launched with no desktop in its environment and `env` on top of it, under `resolver` (every name hidden unless a spec says otherwise). */
export async function launchShellOn (gateway: Awaited<ReturnType<typeof startFixtureGateway>>, env: Record<string, string>, seedProfile?: (dir: string) => void, resolver = HERMETIC_RESOLVER): Promise<Running> {
  const app = await launchWithoutDesktop(async () => await launchElectron({
    appPath: '.',
    args: [resolver],
    env: {
      ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'fixture.eth': `ipfs://${gateway.roots['site']!}`, 'direct.eth': `ipfs://${gateway.roots['site']!}` }),
      ORIVON_TEST_IPFS_GATEWAYS: gateway.url,
      ...env
    },
    ...(seedProfile === undefined ? {} : { seedProfile })
  }))
  const listening = await waitFor(async () => await app.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 30_000)
  if (!listening) throw new Error('the verifier host never reported listening')
  await recordLoadFailures(app)
  return { app, chrome: findChrome(app) }
}

/** What each session kind reports as the proxy for `url`: the answer of `session.resolveProxy`, by partition. */
export async function resolved (app: ElectronApplication, url: string): Promise<Record<string, string>> {
  return await app.evaluate(async ({ session }, target) => {
    const partitions: Array<[string, Electron.Session]> = [
      ['default', session.defaultSession],
      ['direct-profile', session.fromPartition('persist:direct-profile')],
      ['proxy-profile', session.fromPartition('persist:proxy-profile')],
      ['tunnel-profile', session.fromPartition('persist:tunnel-profile')]
    ]
    const out: Record<string, string> = {}
    for (const [name, one] of partitions) out[name] = await one.resolveProxy(target)
    return out
  }, url)
}

export const report = (label: string, facts: unknown): void => { console.log(`[system-proxy] ${label}: ${JSON.stringify(facts)}`) }

/** What the sheet gives for a name the system's proxy would see, for one the session could not say about, and for one asked for over plain http. */
export const ADVICE = 'Names like this open when your system has no proxy, when the proxy\'s exceptions list names like *.eth, or with a tunnel turned on.'
export const PROXY_SHEET = `This name was not opened Your system proxy would see this name, so Orivon did not open it. ${ADVICE}`
export const UNSURE_SHEET = `This name was not opened Orivon could not tell whether your system proxy would see this name, so it did not open it. Trying again may help. ${ADVICE}`
export const PLAIN_SHEET = 'This name opens only over https A name like this opens only over a secure connection, so Orivon did not open it over plain http.'
/** Chromium's name for a request Orivon cancelled before it was sent. */
export const CANCELLED = 'ERR_BLOCKED_BY_CLIENT'

/** Opens the page of `SUBRESOURCES` and waits for its requests to end, then for the connections a hint may still open. */
export async function visitSubresources (app: ElectronApplication, chrome: Page): Promise<Visit> {
  const visit = await visitReporting(app, chrome, SUBRESOURCES, 'subresources settled')
  await new Promise((resolve) => { setTimeout(resolve, 2_000) })
  return visit
}

/** The lines of the main process's log that say a request was refused for the proxy's sake: what a bug report carries. */
export const refusalLines = (app: ElectronApplication): string[] => mainOutput(app).split('\n').filter((line) => line.includes('[route] refused a '))
