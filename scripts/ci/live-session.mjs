/**
 * Drives Orivon live on a GitHub-hosted Windows, macOS or Linux runner, step by step, from any terminal. `start`
 * dispatches live-session.yml on the pushed branch with the SHA-256 of a fresh token, waits for the runner's tunnel
 * address and keeps both in `qa-artifacts/live/<system>.json`; the other commands send Playwright code or ask for a
 * screenshot through it, and save every picture under `qa-artifacts/live/<run id>/`.
 *
 *   node scripts/ci/live-session.mjs start [--system macos] [--minutes 60]
 *   node scripts/ci/live-session.mjs eval [--system macos] [--timeout ms] '<code>' | --file <snippet.js>
 *   node scripts/ci/live-session.mjs shot [--system macos] [desktop | <url part>]
 *   node scripts/ci/live-session.mjs log | restart [--options '<launchElectron options as JSON>'] | stop | status
 */
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly } from '../cli.mjs'
import { dispatch, parseSystems } from './cross-os.mjs'
import { tokenHash } from './live-host.mjs'

export const LIVE_DIR = join('qa-artifacts', 'live')
export const WORKFLOW = 'live-session.yml'
/** The artifact that carries a system's tunnel address; live-session.yml uploads one per system. */
export const urlArtifact = (system) => `live-session-url-${system}`
const READY_MS = 25 * 60_000
const HEALTH_MS = 3 * 60_000

export const sessionPath = (system) => join(LIVE_DIR, `${system}.json`)

/** Where the next picture goes: numbered after the ones already in `dir`, named as the code named it. */
export function nextShotPath (dir, existing, name) {
  const taken = existing.map((file) => Number(/^(\d+)-/.exec(file)?.[1] ?? 0))
  const next = String(Math.max(0, ...taken) + 1).padStart(3, '0')
  return join(dir, `${next}-${name.replace(/[^\w.-]+/g, '-').slice(0, 60)}.png`)
}

/** What an eval reply says, for a terminal: the value or the error, then what the code logged. */
export function formatReply (reply) {
  const out = [reply.ok ? `value: ${reply.value}` : `error: ${reply.error}`]
  for (const line of reply.logs ?? []) out.push(`log: ${line}`)
  return out.join('\n')
}

function gh (...args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function arg (name) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

function readSession (system) {
  const path = sessionPath(system)
  if (!existsSync(path)) throw new Error(`no live session on ${system}: node scripts/ci/live-session.mjs start --system ${system}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** One request to the runner, with the token; `timeoutMs` bounds the whole round trip. */
export async function call (session, method, path, body, timeoutMs = 90_000) {
  const response = await fetch(`${session.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const text = await response.text()
  try { return { status: response.status, ...JSON.parse(text) } } catch { return { status: response.status, ok: false, error: text.slice(0, 500) } }
}

/** Saves the pictures a reply carries, and returns their paths. */
export function saveShots (dir, shots) {
  mkdirSync(dir, { recursive: true })
  return (shots ?? []).map((shot) => {
    const path = nextShotPath(dir, readdirSync(dir), shot.name)
    writeFileSync(path, Buffer.from(shot.png, 'base64'))
    return path
  })
}

async function start (system, minutes) {
  parseSystems(system)
  const token = randomBytes(32).toString('hex')
  const id = await dispatch(WORKFLOW, { system, minutes: String(minutes), token_sha256: tokenHash(token) })
  console.log(`run ${String(id)}: installing and building on ${system}, then opening the tunnel (about 5 minutes)`)
  const dir = join(LIVE_DIR, String(id))
  for (const deadline = Date.now() + READY_MS; ; await sleep(10_000)) {
    if (Date.now() > deadline) throw new Error(`run ${String(id)} opened no tunnel within ${READY_MS / 60_000} minutes`)
    const run = JSON.parse(gh('run', 'view', String(id), '--json', 'status,conclusion'))
    if (run.status === 'completed') throw new Error(`run ${String(id)} ended (${run.conclusion}) before its tunnel opened: node scripts/ci/cross-os.mjs --run ${String(id)}`)
    const names = gh('api', `repos/{owner}/{repo}/actions/runs/${String(id)}/artifacts`, '-q', '.artifacts[].name').split('\n')
    if (names.includes(urlArtifact(system))) break
  }
  gh('run', 'download', String(id), '-n', urlArtifact(system), '-D', dir)
  const session = { system, runId: id, url: readFileSync(join(dir, 'url'), 'utf8').trim(), token }
  for (const deadline = Date.now() + HEALTH_MS; ; await sleep(3000)) {
    const health = await call(session, 'GET', '/health', undefined, 10_000).catch((error) => ({ ok: false, error: String(error) }))
    if (health.ok === true) { session.endsAt = health.endsAt; break }
    if (Date.now() > deadline) throw new Error(`the tunnel at ${session.url} never answered: ${String(health.error)}`)
  }
  mkdirSync(LIVE_DIR, { recursive: true })
  writeFileSync(sessionPath(system), `${JSON.stringify(session, null, 2)}\n`)
  console.log(`live on ${system} until ${String(session.endsAt)}: send code with node scripts/ci/live-session.mjs eval --system ${system} '<code>'`)
}

/** On the runner, for a pull request: the same calls a person makes, through the real tunnel. */
async function selftest (urlFile, tokenFile, out) {
  const session = { url: readFileSync(urlFile, 'utf8').trim(), token: readFileSync(tokenFile, 'utf8').trim() }
  let health
  for (const deadline = Date.now() + HEALTH_MS; ; await sleep(3000)) {
    health = await call(session, 'GET', '/health', undefined, 10_000).catch((error) => ({ ok: false, error: String(error) }))
    if (health.ok === true || Date.now() > deadline) break
  }
  const refused = await call({ ...session, token: '0'.repeat(64) }, 'GET', '/health', undefined, 10_000)
  const reply = await call(session, 'POST', '/eval', { code: "log(await chrome.title()); await shot(chrome, 'chrome'); await shot('desktop', 'desktop'); return chrome.url()" })
  const saved = saveShots(out, reply.shots)
  const failures = [
    health.ok === true ? undefined : `health: ${String(health.error)}`,
    refused.status === 401 ? undefined : `a wrong token got ${String(refused.status)}, not 401`,
    reply.ok === true && /orivon-shell:/.test(String(reply.value)) ? undefined : `eval: ${formatReply(reply)}`,
    saved.length === 2 ? undefined : `${String(saved.length)} of 2 pictures came back`
  ].filter(Boolean)
  await call(session, 'POST', '/stop').catch(() => {})
  console.log(failures.length === 0 ? `selftest: health, token refusal, eval and ${String(saved.length)} pictures all work` : `selftest FAILED:\n  ${failures.join('\n  ')}`)
  return failures.length === 0
}

if (isInvokedDirectly(import.meta.url)) {
  const [command] = process.argv.slice(2)
  const system = arg('system') ?? 'macos'
  try {
    if (command === 'start') {
      await start(system, Number(arg('minutes') ?? 60))
    } else if (command === 'eval' || command === 'shot') {
      const session = readSession(system)
      const target = process.argv.slice(3).filter((part, i, all) => !part.startsWith('--') && !all[i - 1]?.startsWith('--')).join(' ')
      const code = command === 'shot'
        ? `await shot(${JSON.stringify(target || 'desktop')}, ${JSON.stringify(target || 'desktop')}); return 'saved'`
        : arg('file') !== undefined ? readFileSync(arg('file'), 'utf8') : target
      const timeoutMs = Number(arg('timeout') ?? 60_000)
      const reply = await call(session, 'POST', '/eval', { code, timeoutMs }, timeoutMs + 30_000)
      console.log(formatReply(reply))
      for (const path of saveShots(join(LIVE_DIR, String(session.runId)), reply.shots)) console.log(`picture: ${path}`)
      process.exit(reply.ok ? 0 : 1)
    } else if (command === 'log') {
      console.log((await call(readSession(system), 'GET', '/log')).log ?? '')
    } else if (command === 'restart') {
      console.log(JSON.stringify(await call(readSession(system), 'POST', '/restart', { options: arg('options') === undefined ? undefined : JSON.parse(arg('options')) }, 180_000)))
    } else if (command === 'stop') {
      await call(readSession(system), 'POST', '/stop').catch(() => {})
      rmSync(sessionPath(system), { force: true })
      console.log(`stopped the ${system} session`)
    } else if (command === 'status') {
      for (const file of existsSync(LIVE_DIR) ? readdirSync(LIVE_DIR).filter((f) => f.endsWith('.json')) : []) {
        const session = JSON.parse(readFileSync(join(LIVE_DIR, file), 'utf8'))
        const health = await call(session, 'GET', '/health', undefined, 10_000).catch((error) => ({ ok: false, error: String(error) }))
        console.log(`${session.system}: ${health.ok === true ? `up, ends ${String(health.endsAt)}, windows ${health.windows.length}` : `gone (${String(health.error)})`}`)
      }
    } else if (command === 'selftest') {
      process.exit(await selftest(arg('url-file'), arg('token-file'), arg('out') ?? 'live') ? 0 : 1)
    } else {
      console.error('usage: live-session.mjs start | eval | shot | log | restart | stop | status (see the header)')
      process.exit(2)
    }
  } catch (error) {
    console.error(`live-session: ${error.stderr?.trim() || error.message}`)
    process.exit(2)
  }
}
