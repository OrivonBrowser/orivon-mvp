/**
 * Fetches the files of every local node: each `resources/<name>-node/<name>-node.json` manifest names the node's
 * files, which go into `resources/<name>-node/`, which git ignores. A node is a WebAssembly component transpiled
 * by jco, published as one IPFS directory, and each file is checked against its pinned size and sha256 before it
 * is kept.
 *
 * `postinstall`, `npm run dev` and `npm start` call it without `--required`: a failed download prints one
 * line and the browser starts, the node then stays off with that reason. Every `package:*` script passes
 * `--required`, so a release cannot ship with a download that failed. A manifest with no CID yet is not a
 * failed download: a package is built without the node, with a warning, and the node is off in it.
 *
 * `ORIVON_<NAME>_DIR` (`ORIVON_SWARM_NODE_DIR` for `swarm-node`) names a local directory to copy from instead of
 * the network (a build not yet published); every file is still checked.
 *
 * Plain Node and `fetch`, so it runs on Windows and macOS as it does on Linux (Rule 8).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isInvokedDirectly } from './cli.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const RESOURCES_DIR = join(here, '..', 'resources')
const NODE_FOLDER = /^[a-z0-9][a-z0-9-]*-node$/
const ENDPOINTS_FILE = join(here, '..', 'src', 'main', 'verifier', 'endpoints.ts')
const TIMEOUT_MS = 120_000
const PLACEHOLDER = /^PLACEHOLDER/

/** The environment variable naming a local directory to copy a node's files from: the same name the app reads (src/protocols/local-node/protocol.ts). */
export function dirVariable(name) {
  return `ORIVON_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_DIR`
}

/** What `fetchLocalNode` reports while the manifest has no CID. */
export function notPublished(name) {
  return `the ${name} is not published yet (its manifest has no CID); set ${dirVariable(name)} to a directory holding the build`
}

const isNotPublished = (failure) => failure.includes('is not published yet (its manifest has no CID)')

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** The IPFS gateways the verifier asks, read from the one place they are listed. */
export function gatewaysFrom(endpointsSource) {
  const list = /gateways:\s*\[([^\]]*)\]/.exec(endpointsSource)?.[1]
  const gateways = [...(list ?? '').matchAll(/'(https:\/\/[^']+)'/g)].map((match) => match[1])
  if (gateways.length === 0) throw new Error('no gateways found in src/main/verifier/endpoints.ts')
  return gateways
}

/** Whether `bytes` are the pinned file. */
function matches(entry, bytes) {
  return bytes.length === entry.bytes && sha256(bytes) === entry.sha256
}

/** Whether `path` holds the pinned file. */
async function isInPlace(path, entry) {
  return existsSync(path) && matches(entry, await readFile(path))
}

/**
 * Fetches each missing or altered file. Resolves to the failures, one line each; an empty list means every
 * file is in place.
 *
 * @param {object} [options]
 * @param {string} [options.directory] The node's folder under resources, for a test to point elsewhere.
 * @param {string} [options.name] The node's name, which is its manifest's file name; the folder's name by default.
 * @param {string} [options.local] A directory to copy from instead of the network.
 * @param {readonly string[]} [options.gateways] Asked in order, for `/ipfs/<cid>/<file>`.
 * @param {(url: string, init?: object) => Promise<{ ok: boolean, status: number, arrayBuffer: () => Promise<ArrayBuffer | SharedArrayBuffer> }>} [options.fetchImpl] The download, for a test to replace.
 * @returns {Promise<string[]>}
 */
export async function fetchLocalNode({ directory, name = basename(directory), local = process.env[dirVariable(name)], gateways, fetchImpl = fetch }) {
  const manifest = JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'))
  const failures = []
  const missing = []
  for (const entry of manifest.files) if (!(await isInPlace(join(directory, entry.name), entry))) missing.push(entry)
  if (missing.length === 0) return failures
  const local_ = local !== undefined && local !== ''
  if (!local_ && PLACEHOLDER.test(manifest.cid)) return [notPublished(name)]
  const asked = gateways ?? gatewaysFrom(readFileSync(ENDPOINTS_FILE, 'utf8'))
  await mkdir(directory, { recursive: true })
  for (const entry of missing) {
    const target = join(directory, entry.name)
    const temp = `${target}.download`
    try {
      const bytes = local_ ? await readFile(join(local, entry.name)) : await download(entry, manifest.cid, asked, fetchImpl)
      if (!matches(entry, bytes)) throw new Error('it does not match its pinned size and sha256')
      await writeFile(temp, bytes)
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true })
      failures.push(`could not get ${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return failures
}

/** The first gateway whose answer is the pinned file. */
async function download(entry, cid, gateways, fetchImpl) {
  const problems = []
  for (const gateway of gateways) {
    try {
      const response = await fetchImpl(`${gateway}/ipfs/${cid}/${entry.name}`, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!matches(entry, bytes)) throw new Error('not the pinned file')
      return bytes
    } catch (error) {
      problems.push(`${gateway}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(problems.join('; '))
}

/** The names of the local nodes this checkout has a manifest for. */
export function localNodeNames(resources = RESOURCES_DIR) {
  return readdirSync(resources, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && NODE_FOLDER.test(entry.name) && existsSync(join(resources, entry.name, `${entry.name}.json`)))
    .map((entry) => entry.name)
    .sort()
}

/**
 * Fetches every local node's files. Resolves to the failures, one line each, each starting with the node's name.
 *
 * @param {object} [options]
 * @param {string} [options.resources] The resources folder, for a test to point elsewhere.
 * @param {string} [options.local] A directory to copy every node's files from instead of the network (each node's own variable when absent).
 * @param {readonly string[]} [options.gateways] Asked in order, for `/ipfs/<cid>/<file>`.
 * @param {(url: string, init?: object) => Promise<{ ok: boolean, status: number, arrayBuffer: () => Promise<ArrayBuffer | SharedArrayBuffer> }>} [options.fetchImpl] The download, for a test to replace.
 * @returns {Promise<string[]>}
 */
export async function fetchLocalNodes({ resources = RESOURCES_DIR, ...options } = {}) {
  const failures = []
  for (const name of localNodeNames(resources)) {
    for (const failure of await fetchLocalNode({ ...options, directory: join(resources, name), name })) failures.push(`${name}: ${failure}`)
  }
  return failures
}

/** Fails a required fetch for any failure but a node not being published yet, which builds a package without it. */
export function exitCodeFor(failures, required) {
  const real = failures.filter((failure) => !isNotPublished(failure))
  return real.length > 0 && required ? 1 : 0
}

if (isInvokedDirectly(import.meta.url)) {
  const failures = await fetchLocalNodes()
  const required = process.argv.includes('--required')
  for (const failure of failures) console.error(`[fetch-local-nodes] ${failure}`)
  if (failures.length > 0) console.error('[fetch-local-nodes] a node stays off until its files are in place; retry with: node scripts/fetch-local-nodes.mjs')
  if (required) for (const failure of failures.filter(isNotPublished)) console.error(`[fetch-local-nodes] WARNING: this package is built without a node (${failure.split(':')[0]}), which is off in it`)
  process.exit(exitCodeFor(failures, required))
}
