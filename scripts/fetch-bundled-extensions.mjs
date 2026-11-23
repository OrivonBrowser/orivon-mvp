/**
 * Fetches the extensions a new profile starts with (resources/default-profile/bundled-extensions.json)
 * into resources/default-profile/extensions/, which git ignores: each is a pinned release asset,
 * checked against its sha256 before it is kept. Each is then unpacked into a folder beside its file,
 * with a record of what it was unpacked from (src/main/extensions/bundled-folder.ts): a package
 * carries that folder, and the browser loads the extension from it without writing a file.
 *
 * `postinstall`, `npm run dev`, `npm start`, `npm run smoke` and `npm run test:e2e` call it without
 * `--required` (a worktree whose `node_modules` is linked never ran `postinstall`, and the specs of a new
 * profile need the unpacked folder): a failed download
 * prints one line and the browser starts, a new profile then has no bundled extension. Every
 * `package:*` script passes `--required`, so a release cannot ship without them.
 *
 * Plain Node and `fetch`, so it runs on Windows and macOS as it does on Linux (Rule 8).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isInvokedDirectly } from './cli.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const DEFAULT_PROFILE_DIR = join(ROOT, 'resources', 'default-profile')
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
 * @param {(url: string, init?: object) => Promise<{ ok: boolean, status: number, arrayBuffer: () => Promise<ArrayBuffer | SharedArrayBuffer> }>} [fetchImpl] The download, for a test to replace.
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

/** A folder is current while the record beside it holds the digest the list pins and the folder holds its manifest. */
function isUnpacked(folder, entry) {
  try {
    const record = JSON.parse(readFileSync(join(folder, '..', `${entry.file.slice(0, -'.crx'.length)}.bundled.json`), 'utf8'))
    return record.sha256 === entry.sha256 && existsSync(join(folder, 'manifest.json'))
  } catch {
    return false
  }
}

/**
 * The unpacking is TypeScript the browser shares (src/main/extensions/bundled-folder.ts), bundled here on the spot so a
 * build and the app agree on what a bundled folder is; esbuild comes with the build tool, and its output is kept under
 * `.cache/`, where Node finds the two packages it leaves out.
 */
async function loadBundledFolder() {
  // buildSync: esbuild's own build() keeps a service process running that an install's lifecycle script must not leave behind.
  const { buildSync } = await import('esbuild')
  const outfile = join(ROOT, '.cache', 'bundled-folder', 'bundled-folder.mjs')
  buildSync({
    entryPoints: [join(ROOT, 'src', 'main', 'extensions', 'bundled-folder.ts')],
    outfile, bundle: true, platform: 'node', format: 'esm', external: ['adm-zip', 'pbf'], logLevel: 'silent'
  })
  return await import(`${pathToFileURL(outfile).href}?${Date.now()}`)
}

/**
 * Unpacks each fetched extension that is not unpacked yet. Resolves to the failures, one line each, as `fetchBundledExtensions`
 * does; an extension whose file is not there was reported by the fetch.
 *
 * @param {string} [profileDir] The default-profile folder, for a test to point elsewhere.
 * @param {() => Promise<{ prepareBundledFolder: (extensionsDir: string, file: string, folder: string, sha256: string) => boolean }>} [load] Brings in the unpacking, for a test to replace.
 * @returns {Promise<string[]>}
 */
export async function prepareBundledExtensions(profileDir = DEFAULT_PROFILE_DIR, load = loadBundledFolder) {
  const entries = JSON.parse(readFileSync(join(profileDir, 'bundled-extensions.json'), 'utf8'))
  const folder = join(profileDir, 'extensions')
  const failures = []
  let unpacking
  for (const entry of entries) {
    const name = entry.file.slice(0, -'.crx'.length)
    if (!existsSync(join(folder, entry.file)) || isUnpacked(join(folder, name), entry)) continue
    try {
      unpacking ??= await load()
      unpacking.prepareBundledFolder(folder, entry.file, name, entry.sha256)
    } catch (error) {
      failures.push(`could not unpack ${entry.name} ${entry.version}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return failures
}

if (isInvokedDirectly(import.meta.url)) {
  const failures = [...await fetchBundledExtensions(), ...await prepareBundledExtensions()]
  for (const failure of failures) console.error(`[fetch-bundled-extensions] ${failure}`)
  if (failures.length > 0) console.error('[fetch-bundled-extensions] a new profile starts without it; retry with: node scripts/fetch-bundled-extensions.mjs')
  process.exit(failures.length > 0 && process.argv.includes('--required') ? 1 : 0)
}
