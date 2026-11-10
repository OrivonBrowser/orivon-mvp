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
import { expect } from 'vitest'

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
    // A tunnel with no answer here gets a refusal, and a program that resets its socket meanwhile (a proxy set in macOS's settings is every program's) must not end the run.
    client.on('error', () => { client.destroy() })
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

/**
 * A computer whose desktop (KDE's settings) carries the proxy, in a `kioslaverc` under a home of the test's own. Chromium reads
 * `$HOME/.config/kioslaverc` for KDE 5 and 6 and never `XDG_CONFIG_HOME` (here an empty directory, so a reader that looked there
 * would find no proxy), and watches the directory rather than the file, so the directory exists before the launch. `write` changes the port the way the settings window would (KConfig writes a new file and
 * renames it over the old), `off` sets no proxy and leaves the servers in the file, as the window does.
 * `noProxyFor` is the window's list of exceptions: hostnames in it match as suffixes, and `reversed` makes it the only hosts that use the proxy.
 */
export function kdeProxy (home: string, port: number, noProxyFor: readonly string[] = ['localhost', '127.0.0.0/8', '::1'], reversed = false): { env: Record<string, string>, write: (port: number) => void, off: () => void } {
  mkdirSync(join(home, '.config'), { recursive: true })
  mkdirSync(join(home, 'config-elsewhere'), { recursive: true })
  const file = join(home, '.config', 'kioslaverc')
  const save = (type: number, next: number): void => {
    writeFileSync(`${file}.tmp`, `[Proxy Settings]\nNoProxyFor=${noProxyFor.join(',')}\nProxy Config Script=\nProxyType=${String(type)}\nReversedException=${String(reversed)}\nftpProxy=\nhttpProxy=http://127.0.0.1 ${String(next)}\nhttpsProxy=http://127.0.0.1 ${String(next)}\nsocksProxy=\n`)
    renameSync(`${file}.tmp`, file)
  }
  save(1, port)
  return { env: { XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6', HOME: home, XDG_CONFIG_HOME: join(home, 'config-elsewhere') }, write: (next) => { save(1, next) }, off: () => { save(0, port) } }
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

const IE_SETTINGS = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const IE_CONNECTIONS = `${IE_SETTINGS}\\Connections`
const IE_VALUES = { ProxyEnable: 'DWord', ProxyServer: 'String', ProxyOverride: 'String', AutoConfigURL: 'String', AutoDetect: 'DWord' } as const
type IeValue = keyof typeof IE_VALUES

/** Runs `script` and throws when a statement of it fails (a terminating error), which a `try` around a removal of a value that is not there still reports as a failed command unless the script ends with `exit 0`. */
function powershell (script: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${script}; exit 0`], { encoding: 'utf8' }).trim()
}

const quoted = (text: string): string => `'${text.replaceAll("'", "''")}'`

/** Sets each value as Windows' Internet Options would: a number is a DWORD, a text a string, `null` removes the value. */
function setIeValues (values: Partial<Record<IeValue, number | string | null>>): void {
  const lines = Object.entries(values).map(([name, value]) => value === null
    ? `try { Remove-ItemProperty -Path '${IE_SETTINGS}' -Name ${name} -ErrorAction Stop } catch { }`
    : `Set-ItemProperty -Path '${IE_SETTINGS}' -Name ${name} -Value ${typeof value === 'number' ? String(value) : quoted(String(value))} -Type ${IE_VALUES[name as IeValue]}`)
  powershell(lines.join('; '))
}

let blobChanges = 0x20

/** The blob WinINET keeps beside the values: signature, change counter, flags (1 direct, 2 proxy, 4 script, 8 detect), three length-prefixed strings, 32 reserved bytes. */
function ieBlob (flags: number, proxy = '', bypass = ''): number[] {
  const word = (value: number): number[] => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]
  const string = (text: string): number[] => [...word(text.length), ...Buffer.from(text, 'latin1')]
  blobChanges += 1
  return [...word(0x46), ...word(blobChanges), ...word(flags), ...string(proxy), ...string(bypass), ...string(''), ...new Array<number>(32).fill(0)]
}

function setIeBlob (bytes: readonly number[] | null): void {
  powershell(bytes === null
    ? `try { Remove-ItemProperty -Path '${IE_CONNECTIONS}' -Name DefaultConnectionSettings -ErrorAction Stop } catch { }`
    : `if (-not (Test-Path '${IE_CONNECTIONS}')) { New-Item -Path '${IE_CONNECTIONS}' | Out-Null }; Set-ItemProperty -Path '${IE_CONNECTIONS}' -Name DefaultConnectionSettings -Value ([byte[]](${bytes.join(',')})) -Type Binary`)
}

/** Remembers the Windows proxy settings of the user running this, in both forms, and returns what puts them back. */
function rememberIeSettings (): () => void {
  const blob = powershell(`$v = (Get-ItemProperty -Path '${IE_CONNECTIONS}' -Name DefaultConnectionSettings -ErrorAction SilentlyContinue).DefaultConnectionSettings; if ($v) { ($v | ForEach-Object { $_.ToString() }) -join ',' }`)
  const before = Object.fromEntries((Object.keys(IE_VALUES) as IeValue[]).map((name) => {
    const text = powershell(`(Get-ItemProperty -Path '${IE_SETTINGS}' -Name ${name} -ErrorAction SilentlyContinue).${name}`)
    return [name, text === '' ? null : IE_VALUES[name] === 'DWord' ? Number(text) : text]
  })) as Record<IeValue, number | string | null>
  return () => {
    setIeBlob(blob === '' ? null : blob.split(',').map(Number))
    setIeValues(before)
  }
}

/**
 * Turns Windows' "Automatically detect settings" on for the user running this, as its settings page does and as a new
 * installation has it, and returns what puts the setting back. Chromium reads it when a session starts, so it is done before a launch.
 */
export function windowsAutoDetect (): () => void {
  const restore = rememberIeSettings()
  setIeBlob(ieBlob(9))
  setIeValues({ AutoDetect: 1 })
  return restore
}

/**
 * A computer whose Windows settings carry no proxy, no script and no detection: the "Automatically detect settings" box a new
 * installation has ticked is cleared, since a session on detection is never asked about a name the verifier serves. Returns what
 * puts the user's own settings back. Chromium reads them when a session starts, so it is done before a launch.
 */
export function windowsNoProxy (): () => void {
  const restore = rememberIeSettings()
  setIeBlob(ieBlob(1))
  setIeValues({ ProxyEnable: 0, ProxyServer: null, ProxyOverride: null, AutoConfigURL: null, AutoDetect: 0 })
  return restore
}

/** A manual proxy as Windows keeps it: `bypass` is the list written in Internet Options, `detect` the "Automatically detect settings" box. */
export interface WindowsProxy {
  readonly server: string
  readonly bypass?: string
  readonly detect?: boolean
}

/** What a tool wrote: `values` (only `ProxyEnable` and kin, as most proxy tools do), `blob` (only the connection settings) or `both` (what Internet Options writes). */
export type WindowsProxyForm = 'values' | 'blob' | 'both'

/**
 * A computer whose Windows settings carry a manual proxy in one of the forms a tool writes it in. Chromium reads the settings when
 * a session starts and follows a change within a second or two, so `write` also moves the proxy of a running shell; `off` turns the
 * proxy off and `restore` puts the user's own settings back.
 */
export function windowsManualProxy (form: WindowsProxyForm, first: WindowsProxy): { write: (next: WindowsProxy) => void, off: () => void, restore: () => void } {
  const restore = rememberIeSettings()
  const write = (next: WindowsProxy | undefined): void => {
    const detect = next?.detect === true
    if (form !== 'values') setIeBlob(ieBlob((next === undefined ? 1 : 3) | (detect ? 8 : 0), next?.server, next?.bypass))
    else setIeBlob(null)
    if (form === 'blob') setIeValues({ ProxyEnable: null, ProxyServer: null, ProxyOverride: null, AutoConfigURL: null, AutoDetect: null })
    else setIeValues({ ProxyEnable: next === undefined ? 0 : 1, ProxyServer: next?.server ?? null, ProxyOverride: next?.bypass ?? null, AutoConfigURL: null, AutoDetect: detect ? 1 : 0 })
  }
  write(first)
  return { write, off: () => { write(undefined) }, restore }
}

/**
 * A computer whose Windows settings point at a proxy script, as a tool that writes only the values does (`AutoConfigURL`, with the proxy and
 * detection off and no connection blob). `write` points them at another address, `off` removes the script and `restore` puts the user's own settings back.
 */
export function windowsScriptProxy (first: string): { write: (url: string) => void, off: () => void, restore: () => void } {
  const restore = rememberIeSettings()
  const write = (url: string | undefined): void => {
    setIeBlob(null)
    setIeValues({ ProxyEnable: 0, ProxyServer: null, ProxyOverride: null, AutoConfigURL: url ?? null, AutoDetect: 0 })
  }
  write(first)
  return { write, off: () => { write(undefined) }, restore }
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

/**
 * The `CONNECT` lines of `log` that the shell could have sent. On macOS every program of the computer follows the system-wide proxy a
 * spec sets, and Apple's own services (iCloud, CloudKit, software updates, certificate checks) tunnel through it at moments no spec
 * controls, so there a tunnel counts only when it names a host the verifier serves; elsewhere any tunnel counts but the component
 * updater of Chromium.
 */
export const tunnelsOpened = (log: readonly string[]): string[] =>
  log.filter((line) => line.startsWith('CONNECT') && (process.platform === 'darwin' ? verifierNames([line]).length > 0 : !line.includes('gvt1.com')))

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

/** What `scutil --proxy` prints now: the dictionary Chromium reads macOS's proxy settings from. */
function macosProxyDictionary (): string {
  return execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8' })
}

/** Runs `networksetup` as root: GitHub's macOS runners let `sudo` run it without a password. */
function networksetup (...args: string[]): string {
  return execFileSync('/usr/bin/sudo', ['-n', '/usr/sbin/networksetup', ...args], { encoding: 'utf8' })
}

/** The network service macOS keeps the proxy settings of: the one the default route leaves by. */
function macosPrimaryService (): string {
  const device = /interface: (\S+)/.exec(execFileSync('/sbin/route', ['-n', 'get', 'default'], { encoding: 'utf8' }))?.[1]
  const order = execFileSync('/usr/sbin/networksetup', ['-listnetworkserviceorder'], { encoding: 'utf8' })
  for (const found of order.matchAll(/\(\d+\) (.+)\n\(Hardware Port: .*, Device: (\S*)\)/g)) {
    if (found[2] === device) return found[1] as string
  }
  throw new Error('no network service leaves by the default route, so there is no proxy setting to change')
}

export interface MacosProxy {
  /** The web and secure web proxy at `127.0.0.1:port`, with these exceptions in place of the ones the system has (all of them stay when none are given), and no SOCKS proxy. */
  readonly manual: (port: number, exceptions?: readonly string[]) => Promise<void>
  /** A SOCKS proxy at `127.0.0.1:port`, and no web proxy. */
  readonly socks: (port: number) => Promise<void>
  /** The proxy script at `url` ("Automatic proxy configuration"), and no web, secure web or SOCKS proxy. */
  readonly script: (url: string) => Promise<void>
  /** Every proxy off. */
  readonly off: () => Promise<void>
  /** "Exclude simple hostnames" ticked or not. */
  readonly simpleHostnames: (excluded: boolean) => Promise<void>
  /** Puts back what the calls changed. */
  readonly restore: () => void
}

/**
 * The proxy settings of the network service this computer's traffic leaves by, changed with `networksetup` the way the
 * Network settings window would. It writes the computer's own settings, so it belongs on a runner that is thrown away after
 * the run and lets `sudo` run without a password; `restore` puts the settings back all the same.
 */
export function macosProxy (): MacosProxy {
  const service = macosPrimaryService()
  const field = (text: string, label: string): string => new RegExp(`^${label}: ?(.*)$`, 'm').exec(text)?.[1]?.trim() ?? ''
  const read = (...args: string[]): string => execFileSync('/usr/sbin/networksetup', args, { encoding: 'utf8' })
  const servers = [
    { set: '-setwebproxy', state: '-setwebproxystate', get: '-getwebproxy' },
    { set: '-setsecurewebproxy', state: '-setsecurewebproxystate', get: '-getsecurewebproxy' },
    { set: '-setsocksfirewallproxy', state: '-setsocksfirewallproxystate', get: '-getsocksfirewallproxy' }
  ] as const
  const [web, secure, socks] = servers
  const before = servers.map((server) => {
    const text = read(server.get, service)
    return { server, on: field(text, 'Enabled') === 'Yes', host: field(text, 'Server'), port: field(text, 'Port') }
  })
  const exceptions = (): string[] => read('-getproxybypassdomains', service).split('\n').filter((line) => line.trim() !== '' && !line.startsWith('There aren\'t any'))
  const setExceptions = (list: readonly string[]): void => { networksetup('-setproxybypassdomains', service, ...(list.length === 0 ? ['Empty'] : list)) }
  const exceptionsBefore = exceptions()
  const autoBefore = ((): { on: boolean, url: string } => {
    const text = read('-getautoproxyurl', service)
    const url = field(text, 'URL')
    return { on: field(text, 'Enabled') === 'Yes', url: url === '(null)' ? '' : url }
  })()
  const serviceId = /PrimaryService : (\S+)/.exec(execFileSync('/usr/sbin/scutil', [], { input: 'show State:/Network/Global/IPv4\n', encoding: 'utf8' }))?.[1] ?? ''
  const simplePath = `:NetworkServices:${serviceId}:Proxies:ExcludeSimpleHostnames`
  const plist = (command: string): string => execFileSync('/usr/bin/sudo', ['-n', '/usr/libexec/PlistBuddy', '-c', command, '/Library/Preferences/SystemConfiguration/preferences.plist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const simpleBefore = ((): string | undefined => { try { return plist(`Print ${simplePath}`).trim() } catch { return undefined } })()
  const setSimple = (value: string | undefined): void => {
    try { plist(`Delete ${simplePath}`) } catch { /* it was not there */ }
    if (value !== undefined && /^\d+$/.test(value)) plist(`Add ${simplePath} integer ${value}`)
  }
  /** Waits until `scutil --proxy` shows the change, which is what Chromium reads it from. */
  const shown = async (what: string, until: (dictionary: string) => boolean): Promise<void> => {
    if (!await waitFor(() => until(macosProxyDictionary()), 15_000)) throw new Error(`scutil --proxy never showed ${what}: ${macosProxyDictionary()}`)
  }
  const flagOn = (dictionary: string, key: string): boolean => new RegExp(`^ {2}${key} : [1-9]`, 'm').test(dictionary)
  return {
    manual: async (port, list) => {
      networksetup('-setautoproxystate', service, 'off')
      networksetup(socks.state, service, 'off')
      networksetup(web.set, service, '127.0.0.1', String(port))
      networksetup(secure.set, service, '127.0.0.1', String(port))
      if (list !== undefined) setExceptions(list)
      await shown('the proxy', (dictionary) => flagOn(dictionary, 'HTTPSEnable') && dictionary.includes(`HTTPSPort : ${String(port)}`) && !flagOn(dictionary, 'SOCKSEnable') && (list === undefined || list.every((entry) => dictionary.includes(` : ${entry}\n`))))
    },
    socks: async (port) => {
      networksetup('-setautoproxystate', service, 'off')
      networksetup(web.state, service, 'off')
      networksetup(secure.state, service, 'off')
      networksetup(socks.set, service, '127.0.0.1', String(port))
      await shown('the SOCKS proxy', (dictionary) => flagOn(dictionary, 'SOCKSEnable') && dictionary.includes(`SOCKSPort : ${String(port)}`) && !flagOn(dictionary, 'HTTPEnable') && !flagOn(dictionary, 'HTTPSEnable'))
    },
    script: async (url) => {
      for (const { state } of servers) networksetup(state, service, 'off')
      networksetup('-setautoproxyurl', service, url)
      networksetup('-setautoproxystate', service, 'on')
      await shown('the proxy script', (dictionary) => flagOn(dictionary, 'ProxyAutoConfigEnable') && dictionary.includes(`ProxyAutoConfigURLString : ${url}`) && !flagOn(dictionary, 'HTTPEnable') && !flagOn(dictionary, 'HTTPSEnable') && !flagOn(dictionary, 'SOCKSEnable'))
    },
    off: async () => {
      networksetup('-setautoproxystate', service, 'off')
      for (const { state } of servers) networksetup(state, service, 'off')
      await shown('every proxy off', (dictionary) => !flagOn(dictionary, 'HTTPEnable') && !flagOn(dictionary, 'HTTPSEnable') && !flagOn(dictionary, 'SOCKSEnable') && !flagOn(dictionary, 'ProxyAutoConfigEnable'))
    },
    simpleHostnames: async (excluded) => {
      setSimple(excluded ? '1' : '0')
      // The system reads the file again on the next change through networksetup, so the exceptions are set to what they are.
      setExceptions(exceptions())
      await shown('the setting for simple host names', (dictionary) => flagOn(dictionary, 'ExcludeSimpleHostnames') === excluded)
    },
    restore: () => {
      for (const { server, on, host, port } of before) {
        if (on && host !== '') networksetup(server.set, service, host, port)
        else networksetup(server.state, service, 'off')
      }
      if (autoBefore.url !== '') networksetup('-setautoproxyurl', service, autoBefore.url)
      networksetup('-setautoproxystate', service, autoBefore.on ? 'on' : 'off')
      setSimple(simpleBefore)
      setExceptions(exceptionsBefore)
    }
  }
}

export interface SystemProxyFact { readonly source: string, readonly mode: string, readonly state: string, readonly reason: string }

/** Opens `orivon://report` and reads the mirror's fact, the log lines it wrote and the whole preview text, once main has built the preview. The log is read from the report because the lines a launch prints first reach a test's capture of the output only by chance. */
export async function reportedMirror (app: ElectronApplication, chrome: Page): Promise<{ fact: SystemProxyFact | undefined, lines: string[], text: string }> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('report.open') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://report') && !w.isClosed()))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://report') && !w.isClosed()) as Page
  await page.waitForSelector('#report-what')
  let text = ''
  let fact: SystemProxyFact | undefined
  let lines: string[] = []
  await waitFor(async () => {
    text = await page.locator('#report-preview').textContent() ?? ''
    try {
      const shown = JSON.parse(text === '' ? '{}' : text) as { log?: string[] | null, diagnostics?: { browser?: { systemProxy?: SystemProxyFact } } }
      fact = shown.diagnostics?.browser?.systemProxy
      lines = (shown.log ?? []).filter((line) => line.includes('[route] system proxy:')).map((line) => line.slice(line.indexOf('[route]')))
    } catch { fact = undefined }
    return fact !== undefined
  }, 15_000)
  return { fact, lines, text }
}

/** Waits until the default session answers `url` as `expected` says, which is how a change of the copy shows. A change is followed within a few seconds (the question to Chromium is asked every 2 s; the settings are read every 30 s), so the bound is far under the read's. */
export async function waitForAnswer (app: ElectronApplication, url: string, expected: RegExp, timeoutMs = 15_000): Promise<string> {
  let last = ''
  const settled = await waitFor(async () => { last = (await resolved(app, url))['default'] ?? ''; return expected.test(last) }, timeoutMs)
  if (!settled) throw new Error(`the default session still answers ${last} for ${url}`)
  return last
}
