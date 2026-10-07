/**
 * Fetches the extensions a new profile starts with (resources/default-profile/bundled-extensions.json)
 * into resources/default-profile/extensions/, which git ignores: each is a pinned release asset,
 * checked against its sha256 before it is kept.
 *
 * `postinstall`, `npm run dev` and `npm start` call it without `--required`: a failed download
 * prints one line and the browser starts, a new profile then has no bundled extension. Every
 * `package:*` script passes `--required`, so a release cannot ship without them.
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
const DEFAULT_PROFILE_DIR = join(here, '..', 'resources', 'default-profile')
const TIMEOUT_MS = 120_000

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Whether `path` holds a file with this digest. */
async function hasDigest(path, digest) {
  if (!existsSync(path)) return false
  return sha256(await readFile(path)) === digest
}

/**
 * Fetches each missing or altered entry. Resolves to the failures, one line each; an empty list
 * means every extension is in place.
 *
 * @param {string} [profileDir] The default-profile folder, for a test to point elsewhere.
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string[]>}
 */
export async function fetchBundledExtensions(profileDir = DEFAULT_PROFILE_DIR, fetchImpl = fetch) {
  const entries = JSON.parse(readFileSync(join(profileDir, 'bundled-extensions.json'), 'utf8'))
  const folder = join(profileDir, 'extensions')
  const failures = []
  for (const entry of entries) {
    const target = join(folder, entry.file)
    if (await hasDigest(target, entry.sha256)) continue
    const temp = `${target}.download`
    try {
      await mkdir(folder, { recursive: true })
      const response = await fetchImpl(entry.url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (sha256(bytes) !== entry.sha256) throw new Error('the download does not match its pinned sha256')
      await writeFile(temp, bytes)
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true })
      failures.push(`could not fetch ${entry.name} ${entry.version} from ${entry.url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return failures
}

if (isInvokedDirectly(import.meta.url)) {
  const failures = await fetchBundledExtensions()
  for (const failure of failures) console.error(`[fetch-bundled-extensions] ${failure}`)
  if (failures.length > 0) console.error('[fetch-bundled-extensions] a new profile starts without it; retry with: node scripts/fetch-bundled-extensions.mjs')
  process.exit(failures.length > 0 && process.argv.includes('--required') ? 1 : 0)
}
