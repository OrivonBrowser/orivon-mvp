/**
 * Fetches the Swarm light node's files (resources/swarm-node/swarm-node.json) into
 * resources/swarm-node/, which git ignores: the node is a WebAssembly component transpiled by jco, published
 * as one IPFS directory, and each file is checked against its pinned size and sha256 before it is kept.
 *
 * `postinstall`, `npm run dev` and `npm start` call it without `--required`: a failed download prints one
 * line and the browser starts, Swarm then stays off with that reason. Every `package:*` script passes
 * `--required`, so a release cannot ship with a download that failed. A manifest with no CID yet is not a
 * failed download: a package is built without the node, with a warning, and Swarm is off in it.
 *
 * `ORIVON_SWARM_NODE_DIR` names a local directory to copy from instead of the network (a build not yet
 * published); every file is still checked.
 *
 * Plain Node and `fetch`, so it runs on Windows and macOS as it does on Linux (Rule 8).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isInvokedDirectly } from './cli.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SWARM_NODE_DIR = join(here, '..', 'resources', 'swarm-node')
const ENDPOINTS_FILE = join(here, '..', 'src', 'main', 'verifier', 'endpoints.ts')
const TIMEOUT_MS = 120_000
const PLACEHOLDER = /^PLACEHOLDER/
/** What `fetchSwarmNode` reports while the manifest has no CID. */
export const NOT_PUBLISHED = 'the Swarm node is not published yet (its manifest has no CID); set ORIVON_SWARM_NODE_DIR to a directory holding the build'

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
 * @param {string} [options.directory] The swarm-node folder, for a test to point elsewhere.
 * @param {string} [options.local] A directory to copy from instead of the network.
 * @param {readonly string[]} [options.gateways] Asked in order, for `/ipfs/<cid>/<file>`.
 * @param {(url: string, init?: object) => Promise<{ ok: boolean, status: number, arrayBuffer: () => Promise<ArrayBuffer | SharedArrayBuffer> }>} [options.fetchImpl] The download, for a test to replace.
 * @returns {Promise<string[]>}
 */
export async function fetchSwarmNode({ directory = SWARM_NODE_DIR, local = process.env.ORIVON_SWARM_NODE_DIR, gateways, fetchImpl = fetch } = {}) {
  const manifest = JSON.parse(readFileSync(join(directory, 'swarm-node.json'), 'utf8'))
  const failures = []
  const missing = []
  for (const entry of manifest.files) if (!(await isInPlace(join(directory, entry.name), entry))) missing.push(entry)
  if (missing.length === 0) return failures
  const local_ = local !== undefined && local !== ''
  if (!local_ && PLACEHOLDER.test(manifest.cid)) return [NOT_PUBLISHED]
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

/** Fails a required fetch for any failure but the node not being published yet, which builds a package without it. */
export function exitCodeFor(failures, required) {
  const real = failures.filter((failure) => failure !== NOT_PUBLISHED)
  return real.length > 0 && required ? 1 : 0
}

if (isInvokedDirectly(import.meta.url)) {
  const failures = await fetchSwarmNode()
  for (const failure of failures) console.error(`[fetch-swarm-node] ${failure}`)
  if (failures.length > 0) console.error('[fetch-swarm-node] Swarm stays off until the node is in place; retry with: node scripts/fetch-swarm-node.mjs')
  if (failures.includes(NOT_PUBLISHED) && process.argv.includes('--required')) console.error('[fetch-swarm-node] WARNING: this package is built without the Swarm node, and Swarm is off in it')
  process.exit(exitCodeFor(failures, process.argv.includes('--required')))
}
