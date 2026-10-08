/**
 * The runner's half of a live session (live-session.yml): launches Orivon under Playwright, serves a small HTTP API
 * on loopback that runs the caller's Playwright code against it, and opens a Cloudflare quick tunnel to that API.
 * Every request carries a bearer token whose SHA-256 is all the runner is given. Writes `<out>/url` once the tunnel
 * is up, writes the time to `<out>/alive` every 30 seconds, and writes `<out>/stopped` when the session ends: on `/stop`, after
 * `--minutes`, after 20 idle minutes, or when it fails to start.
 *
 *   node scripts/run-headless.mjs node scripts/ci/live-host.mjs serve --hash <sha256> --cloudflared <path> --out <dir>
 *   node scripts/ci/live-host.mjs fetch-cloudflared <dir>     prints the path of the pinned binary it saved there
 *   node scripts/ci/live-host.mjs new-token <file>            saves a fresh token there and prints its SHA-256
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isInvokedDirectly } from '../cli.mjs'

/** cloudflared, pinned: the file each system downloads and GitHub's SHA-256 of it. */
export const CLOUDFLARED_VERSION = '2026.10.0'
const CLOUDFLARED = {
  'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', sha256: 'a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70' },
  'linux-x64': { file: 'cloudflared-linux-amd64', sha256: 'd33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db' },
  'win32-x64': { file: 'cloudflared-windows-amd64.exe', sha256: '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c' }
}
const IDLE_MS = 20 * 60_000
const MAX_MINUTES = 300
const EVAL_TIMEOUT_MS = 60_000
/** Cloudflare ends a tunnelled response at 100 seconds, so no call may run longer than this. */
export const MAX_EVAL_MS = 90_000
const MAX_BODY = 1024 * 1024
const MAX_VALUE = 20_000

/** @param {string} platform @param {string} arch */
export function cloudflaredAsset (platform, arch) {
  const asset = CLOUDFLARED[`${platform}-${arch}`]
  if (asset === undefined) throw new Error(`no pinned cloudflared for ${platform}-${arch}`)
  return { ...asset, url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.file}` }
}

/**
 * The quick tunnel's address, from what cloudflared prints, once it has registered a connection: it prints the
 * address first, and a name asked for before then may not resolve yet.
 */
export function tunnelUrl (output) {
  if (!/Registered tunnel connection/.test(output)) return undefined
  return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(output)?.[0]
}

export const tokenHash = (token) => createHash('sha256').update(token).digest('hex')
export const isTokenHash = (text) => /^[0-9a-f]{64}$/.test(text)

/** Whether `header` is `Bearer <token>` for the token whose hash is `expected`, compared in constant time. */
export function tokenMatches (header, expected) {
  const token = /^Bearer (\S+)$/.exec(header ?? '')?.[1]
  if (token === undefined || !isTokenHash(expected)) return false
  return timingSafeEqual(Buffer.from(tokenHash(token), 'hex'), Buffer.from(expected, 'hex'))
}

/** Caller code as a function body: a lone expression with no `return` is returned. */
export function functionBody (code) {
  const trimmed = code.trim()
  return /\breturn\b/.test(trimmed) || /[;\n]/.test(trimmed.replace(/;$/, '')) ? trimmed : `return (${trimmed.replace(/;$/, '')})`
}

/** What saves a picture of the whole screen, the parts the operating system draws included. */
export function desktopShotCommand (platform, file) {
  if (platform === 'darwin') return { file: 'screencapture', args: ['-x', file] }
  if (platform === 'win32') {
    const script = 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ' +
      '$m=New-Object System.Drawing.Bitmap $b.Width,$b.Height; [System.Drawing.Graphics]::FromImage($m).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ' +
      `$m.Save('${file.replaceAll("'", "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`
    return { file: 'powershell', args: ['-NoProfile', '-Command', script] }
  }
  return { file: 'import', args: ['-window', 'root', file] }
}

/** A value as JSON the caller can read, cut at MAX_VALUE characters. */
export function serialize (value) {
  const seen = new WeakSet()
  let text
  try {
    text = JSON.stringify(value, (_key, v) => {
      if (typeof v === 'object' && v !== null) { if (seen.has(v)) return '[circular]'; seen.add(v) }
      return typeof v === 'bigint' ? String(v) : v
    })
  } catch (error) { text = JSON.stringify(String(error)) }
  text ??= 'undefined'
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}... [${text.length - MAX_VALUE} more characters]` : text
}

async function fetchCloudflared (dir) {
  const asset = cloudflaredAsset(process.platform, process.arch)
  const bytes = Buffer.from(await (await fetch(asset.url)).arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`${asset.file} does not match its pinned SHA-256`)
  mkdirSync(dir, { recursive: true })
  const download = join(dir, asset.file)
  writeFileSync(download, bytes)
  if (asset.file.endsWith('.tgz')) execFileSync('tar', ['-xzf', download, '-C', dir])
  const binary = asset.file.endsWith('.tgz') ? join(dir, 'cloudflared') : download
  chmodSync(binary, 0o755)
  return binary
}

async function readBody (req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('body over 1 MB')
    chunks.push(chunk)
  }
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** A fresh token, saved to `file` for the session's own caller; returns its SHA-256. */
export function newToken (file) {
  const token = randomBytes(32).toString('hex')
  writeFileSync(file, token, { mode: 0o600 })
  return tokenHash(token)
}

/**
 * The API's request listener. A request without the token is refused before anything else is read or reset. `/health`
 * and `/stop` are answered at once; every other route runs one at a time, in the order the requests came.
 * @param {{ hash: string, routes: Record<string, (body: any) => Promise<unknown>>, onRequest?: () => void }} api
 */
export function apiListener ({ hash, routes, onRequest = () => {} }) {
  let queue = Promise.resolve()
  return (req, res) => {
    const reply = (status, payload) => {
      if (res.headersSent || res.destroyed) return
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (!tokenMatches(req.headers.authorization, hash)) { reply(401, { ok: false, error: 'bad token' }); return }
    const key = `${req.method ?? ''} ${(req.url ?? '').split('?')[0]}`
    const route = routes[key]
    if (route === undefined) { reply(404, { ok: false, error: 'no such route' }); return }
    onRequest()
    const answer = async (body) => {
      try { reply(200, await route(body)) } catch (error) { reply(500, { ok: false, error: String(error?.stack ?? error) }) }
    }
    readBody(req).then((body) => {
      if (key === 'GET /health' || key === 'POST /stop') return answer(body)
      queue = queue.then(() => answer(body))
      return queue
    }, (error) => { reply(400, { ok: false, error: String(error?.message ?? error) }) })
  }
}

async function serve ({ hash, cloudflared, out, minutes }) {
  if (!isTokenHash(hash)) throw new Error('--hash is not a SHA-256 in hex: live-session.mjs start makes one')
  const { closeElectron, launchElectron, mainOutput } = await import('../../test/support/launch-electron.mjs')
  const helpers = await import('../../test/support/smoke-helpers.mjs')
  mkdirSync(out, { recursive: true })
  // Caller code that leaves a promise to reject, or throws in a callback, must not end the session.
  process.on('unhandledRejection', (error) => { console.error(`[live-host] unhandled rejection: ${String(error?.stack ?? error)}`) })
  process.on('uncaughtException', (error) => { console.error(`[live-host] uncaught exception: ${String(error?.stack ?? error)}`) })
  const started = Date.now()
  let app
  let launchOptions = {}
  let lastRequest = Date.now()
  let tunnel
  let stopping = false
  let pictures = 0

  const launch = async (options) => {
    app = await launchElectron({ appPath: '.', ...options })
    await helpers.waitForChromeView(app)
    launchOptions = options
  }
  const page = (part) => app.windows().find((p) => p.url().includes(part))
  /** A `shot` that adds its pictures to one call's reply only, even if that call has timed out and still runs. */
  const shooter = (shots) => async (target = 'desktop', name = `shot-${String(shots.length + 1)}`) => {
    const file = join(tmpdir(), `orivon-live-${String(process.pid)}-${String(++pictures)}.png`)
    if (target === 'desktop') {
      const command = desktopShotCommand(process.platform, file)
      execFileSync(command.file, command.args, { stdio: 'ignore', timeout: 30_000 })
    } else {
      await (typeof target === 'string' ? page(target) : target).screenshot({ path: file })
    }
    shots.push({ name, png: readFileSync(file).toString('base64') })
    return name
  }

  const stop = async (why) => {
    if (stopping) return
    stopping = true
    console.log(`[live-host] stopping: ${why}`)
    try { if (app !== undefined) await closeElectron(app) } catch {}
    tunnel?.kill()
    writeFileSync(join(out, 'stopped'), `${why}\n`)
    process.exit(0)
  }

  const routes = {
    'GET /health': async () => ({
      ok: true, platform: process.platform, arch: process.arch, uptimeS: Math.round((Date.now() - started) / 1000),
      endsAt: new Date(started + minutes * 60_000).toISOString(), windows: app?.windows().map((p) => p.url()) ?? []
    }),
    'GET /log': async () => ({ log: mainOutput(app).split('\n').slice(-300).join('\n') }),
    'POST /eval': async (body) => {
      const shots = []
      const logs = []
      const log = (...parts) => { logs.push(parts.map((p) => typeof p === 'string' ? p : serialize(p)).join(' ')) }
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      const run = new AsyncFunction('ctx', `const { app, chrome, page, shot, log, helpers } = ctx\n${functionBody(String(body.code ?? ''))}`)
      const timeout = Math.min(Number(body.timeoutMs) || EVAL_TIMEOUT_MS, MAX_EVAL_MS)
      // Left undefined once the shell's view is gone, so code can still look at app.windows() and the log.
      let chrome
      try { chrome = helpers.findChrome(app) } catch {}
      let timer
      try {
        const value = await Promise.race([
          run({ app, chrome, page, shot: shooter(shots), log, helpers }),
          new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`no result within ${timeout} ms`)), timeout) })
        ])
        return { ok: true, value: serialize(value), logs, shots: [...shots] }
      } catch (error) {
        return { ok: false, error: String(error?.stack ?? error), logs, shots: [...shots] }
      } finally { clearTimeout(timer) }
    },
    'POST /restart': async (body) => {
      try { await closeElectron(app) } catch {}
      await launch(body.options ?? launchOptions)
      return { ok: true, windows: app.windows().map((p) => p.url()) }
    },
    'POST /stop': async () => { setTimeout(() => { void stop('asked to stop') }, 200); return { ok: true } }
  }

  const server = createServer(apiListener({ hash, routes, onRequest: () => { lastRequest = Date.now() } }))
  await launch({})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  tunnel = spawn(cloudflared, ['tunnel', '--url', `http://127.0.0.1:${String(port)}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let said = ''
  const hear = (chunk) => {
    appendFileSync(join(out, 'cloudflared.log'), chunk)
    said += chunk
    const url = tunnelUrl(said)
    if (url !== undefined && !existsSync(join(out, 'url'))) { writeFileSync(join(out, 'url'), `${url}\n`); console.log('[live-host] tunnel up') }
  }
  tunnel.stdout.on('data', hear)
  tunnel.stderr.on('data', hear)
  tunnel.on('error', (error) => { void stop(`cloudflared did not run: ${error.message}`) })
  tunnel.on('exit', (code) => { void stop(`cloudflared exited (${String(code)})`) })

  // Seconds since the epoch: the workflow's hold step compares it with `date +%s` on every system.
  const beat = () => { writeFileSync(join(out, 'alive'), `${String(Math.floor(Date.now() / 1000))}\n`) }
  beat()
  setTimeout(() => { void stop(`${String(minutes)} minutes passed`) }, minutes * 60_000)
  setInterval(() => {
    beat()
    if (Date.now() - lastRequest > IDLE_MS) void stop('20 minutes without a request')
  }, 30_000)
}

function arg (name) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

if (isInvokedDirectly(import.meta.url)) {
  const [command, target] = process.argv.slice(2)
  try {
    if (command === 'fetch-cloudflared') {
      console.log(await fetchCloudflared(target ?? tmpdir()))
    } else if (command === 'new-token' && target !== undefined) {
      console.log(newToken(target))
    } else if (command === 'serve') {
      const minutes = Math.min(Number(arg('minutes') ?? 60) || 60, MAX_MINUTES)
      await serve({ hash: arg('hash') ?? '', cloudflared: arg('cloudflared') ?? 'cloudflared', out: arg('out') ?? 'live', minutes })
    } else {
      console.error('usage: live-host.mjs serve --hash <sha256> --cloudflared <path> --out <dir> [--minutes N] | fetch-cloudflared <dir> | new-token <file>')
      process.exit(2)
    }
  } catch (error) {
    console.error(`[live-host] ${error?.stack ?? error}`)
    // The workflow waits for `url` or `stopped`; a session that never started says so instead of timing out.
    if (command === 'serve') {
      try { mkdirSync(arg('out') ?? 'live', { recursive: true }); writeFileSync(join(arg('out') ?? 'live', 'stopped'), `failed to start: ${String(error?.message ?? error)}\n`) } catch {}
    }
    process.exit(1)
  }
}
