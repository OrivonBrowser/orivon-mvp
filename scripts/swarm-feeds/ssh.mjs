/**
 * Running a command on another machine over `ssh`, for the two inputs that live on the pinning node: Kubo's RPC (curl
 * against its loopback port) and the names file (`cat`). The remote command is one string a shell reads, so every value in
 * it is single-quoted; the target itself is checked against a strict pattern, so it can never be taken for an ssh option.
 */
import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'

const TARGET = /^ssh:\/\/([A-Za-z0-9_][A-Za-z0-9._-]*)@([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{1,5}))?(\/[^\0\n]*)?$/
const RPC_URL = /^https?:\/\/[A-Za-z0-9.:[\]-]+$/

/** @typedef {typeof spawn} SpawnFn */

/**
 * @param {string} url `ssh://user@host[:port][/absolute/path]`
 * @param {{ path: boolean }} options whether the URL must carry an absolute path (a file) or none (a node)
 * @returns {{ user: string, host: string, port: string | undefined, path: string | undefined } | null} null when it is not an ssh URL
 * @throws {Error} when it starts with ssh:// and is malformed
 */
export function parseSshUrl (url, { path }) {
  if (!url.startsWith('ssh://')) return null
  const match = TARGET.exec(url)
  if (match === null) throw new Error(`"${url}" is not ssh://user@host[:port]${path ? '/absolute/path' : ''}`)
  const [, user = '', host = '', port, file] = match
  if (port !== undefined && Number(port) > 65_535) throw new Error(`"${url}" has no such port`)
  if (path && file === undefined) throw new Error(`"${url}" needs an absolute path after the host`)
  if (!path && file !== undefined) throw new Error(`"${url}" must name only user@host[:port]`)
  return { user, host, port, path: file }
}

/** @param {string} text @returns {string} the text as one word of a POSIX shell */
export const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`

/**
 * @param {{ user: string, host: string, port: string | undefined }} target
 * @param {string} command what the remote shell runs
 * @returns {string[]} ssh's arguments: it never asks a question, so a missing key fails at once
 */
export const sshArgv = ({ user, host, port }, command) => ['-o', 'BatchMode=yes', ...(port === undefined ? [] : ['-p', port]), `${user}@${host}`, command]

/** @param {string} what @param {number | null} code @param {string | null} signal @param {string} stderr */
const failure = (what, code, signal, stderr) => new Error(`${what} failed (${code === null ? `killed by ${String(signal)}` : `exit ${String(code)}`})${stderr.trim() === '' ? '' : `: ${stderr.trim().slice(-300)}`}`)

/**
 * The whole stdout of a command, for small answers. A non-zero exit rejects, with what the command wrote to stderr.
 * @param {{ argv: string[], what: string, spawnFn?: SpawnFn, timeout?: number }} input
 * @returns {Promise<Buffer>}
 */
export function sshRun ({ argv, what, spawnFn = spawn, timeout = 120_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawnFn('ssh', argv, { stdio: ['ignore', 'pipe', 'pipe'], timeout })
    /** @type {Buffer[]} */
    const out = []
    let stderr = ''
    child.stdout?.on('data', (/** @type {Buffer} */ chunk) => { out.push(chunk) })
    child.stderr?.on('data', (/** @type {Buffer} */ chunk) => { stderr = (stderr + String(chunk)).slice(-4000) })
    child.on('error', (error) => { reject(new Error(`${what} could not start ssh: ${error.message}`)) })
    child.on('close', (code, signal) => {
      if (code === 0) resolve(Buffer.concat(out))
      else reject(failure(what, code, signal, stderr))
    })
  })
}

/**
 * The stdout of a command as a stream, for a transfer too large to hold: chunks are passed on as the consumer takes them.
 * A non-zero exit ends the stream with an error rather than a clean end, so a cut-off archive is never read as whole.
 * @param {{ argv: string[], what: string, spawnFn?: SpawnFn, timeout?: number }} input
 * @returns {import('node:stream').Readable}
 */
export function sshStream ({ argv, what, spawnFn = spawn, timeout = 3_600_000 }) {
  const out = new PassThrough()
  const child = spawnFn('ssh', argv, { stdio: ['ignore', 'pipe', 'pipe'], timeout })
  let stderr = ''
  child.stdout?.pipe(out, { end: false })
  child.stderr?.on('data', (/** @type {Buffer} */ chunk) => { stderr = (stderr + String(chunk)).slice(-4000) })
  child.on('error', (error) => { out.destroy(new Error(`${what} could not start ssh: ${error.message}`)) })
  child.on('close', (code, signal) => {
    if (code === 0) out.end()
    else out.destroy(failure(what, code, signal, stderr))
  })
  // A consumer that gives up (tar failed, the run was stopped) must not leave a download running on the other machine.
  out.on('close', () => { if (child.exitCode === null) child.kill() })
  return out
}

/**
 * Kubo's RPC through ssh: each call is `curl -X POST` against the node's own loopback address on the remote machine.
 * @param {{ target: { user: string, host: string, port: string | undefined }, rpc: string, spawnFn?: SpawnFn }} config
 */
export function sshKubo ({ target, rpc, spawnFn }) {
  if (!RPC_URL.test(rpc)) throw new Error(`IPFS_SSH_RPC "${rpc}" is not an http(s) address`)
  const base = rpc.replace(/\/+$/, '')
  /** @param {string} path */
  const argvFor = (path) => sshArgv(target, `curl -sS --fail -X POST ${shellQuote(`${base}/api/v0/${path}`)}`)
  return {
    /** @param {string} path @param {number} timeout @returns {Promise<string>} */
    text: async (path, timeout) => (await sshRun({ argv: argvFor(path), what: `Kubo ${path.split('?')[0] ?? path} over ssh`, spawnFn, timeout })).toString('utf8'),
    /** @param {string} path @param {number} timeout @returns {Promise<import('node:stream').Readable>} */
    stream: async (path, timeout) => sshStream({ argv: argvFor(path), what: `Kubo ${path.split('?')[0] ?? path} over ssh`, spawnFn, timeout })
  }
}

/**
 * A file on another machine.
 * @param {string} url `ssh://user@host[:port]/absolute/path`
 * @param {SpawnFn} [spawnFn]
 * @returns {Promise<string>}
 */
export async function readRemoteFile (url, spawnFn) {
  const target = parseSshUrl(url, { path: true })
  if (target === null || target.path === undefined) throw new Error(`"${url}" is not an ssh:// address`)
  return (await sshRun({ argv: sshArgv(target, `cat -- ${shellQuote(target.path)}`), what: `reading ${url}`, spawnFn, timeout: 60_000 })).toString('utf8')
}
