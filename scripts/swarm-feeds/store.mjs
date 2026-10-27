/**
 * What the job reads and keeps on disk: the names file, the signer key, `state.json` (written whole, atomically),
 * `socs.jsonl` (one signed update per line, only ever appended to) and `status.json`.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** A configuration or input error the caller fixes: exit code 2. */
export class UsageError extends Error {}

const KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * `<ipns-key-name> <ens names...>` per line; blank lines and `#` comments ignored.
 * @param {string} text
 * @param {Iterable<string>} [skip] key names left out
 * @returns {{ key: string, names: string[] }[]}
 */
export function parseNames (text, skip = []) {
  const skipped = new Set(skip)
  /** @type {{ key: string, names: string[] }[]} */
  const sites = []
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/#.*$/, '').trim()
    if (line === '') continue
    const [key = '', ...names] = line.split(/\s+/)
    if (!KEY_NAME.test(key)) throw new UsageError(`names file line ${String(i + 1)}: "${key}" is not an IPNS key name`)
    if (sites.some((site) => site.key === key)) throw new UsageError(`names file line ${String(i + 1)}: key ${key} is listed twice`)
    if (!skipped.has(key)) sites.push({ key, names })
  }
  return sites
}

/** @param {string | undefined} value a comma-separated list @returns {string[]} */
export const parseList = (value) => (value ?? '').split(',').map((item) => item.trim()).filter((item) => item !== '')

/**
 * @param {string} text the key file: 64 hex characters, optionally behind 0x
 * @returns {string} lowercase hex, no prefix
 */
export function parseSignerKey (text) {
  const key = text.trim().replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new UsageError('the signer key file must hold 64 hex characters (a secp256k1 private key)')
  return key.toLowerCase()
}

/**
 * Reads the signer key file. A key that group or other can read is refused: the key signs every update of every site.
 * @param {string} file
 * @returns {string} lowercase hex, no prefix
 */
export function readSignerKeyFile (file) {
  let text
  try {
    const { mode } = statSync(file)
    if (process.platform !== 'win32' && (mode & 0o077) !== 0) throw new UsageError(`the signer key file ${file} can be read by other users (mode ${(mode & 0o777).toString(8)}): run chmod 600 on it`)
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error instanceof UsageError) throw error
    throw new UsageError(`the signer key file ${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseSignerKey(text)
}

/** @param {string} file @param {string} text */
function writeAtomic (file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, text)
  renameSync(`${file}.tmp`, file)
}

/**
 * pointer, content: `{ id, depth, label, boughtAt, changedAt }` or null. retired: content batches no longer topped up.
 * sites[key]: topic, manifest (the feed's root reference), index and published (the newest update and the reference it
 * names), cid, reference and batch (the version uploaded and synced, and the batch holding it), pending (an upload
 * whose chunks are still being pushed).
 * @typedef {{ version: 1, pointer: any, content: any, retired: { id: string, depth: number, retiredAt: string, reason: string }[], restorePending: boolean, sites: Record<string, any> }} State
 * @returns {State}
 */
export const emptyState = () => ({ version: 1, pointer: null, content: null, retired: [], restorePending: false, sites: {} })

/** @param {string} dir @returns {State} a missing file is a first run; a file that cannot be read stops the run */
export function loadState (dir) {
  let text
  try { text = readFileSync(join(dir, 'state.json'), 'utf8') } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return emptyState()
    throw error
  }
  return { ...emptyState(), ...JSON.parse(text) }
}

/** @param {string} dir @param {State} state */
export const saveState = (dir, state) => { writeAtomic(join(dir, 'state.json'), JSON.stringify(state, null, 2)) }

/** @param {string} dir @param {unknown} status */
export const writeStatus = (dir, status) => { writeAtomic(join(dir, 'status.json'), JSON.stringify(status, null, 2)) }

/**
 * @typedef {{ key: string, topic: string, index: number, identifier: string, signature: string, data: string, reference: string, cid: string, time: string }} Soc
 */

/** @param {string} dir @returns {Soc[]} every signed update, in the order written; a line cut short by a crash is skipped */
export function readJournal (dir) {
  let text
  try { text = readFileSync(join(dir, 'socs.jsonl'), 'utf8') } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return []
    throw error
  }
  /** @type {Soc[]} */
  const entries = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { entries.push(JSON.parse(line)) } catch { /* torn last line */ }
  }
  return entries
}

/** Written to disk before the update is uploaded, so an upload that dies halfway is retried with the same signature. @param {string} dir @param {Soc} entry */
export function appendJournal (dir, entry) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'socs.jsonl')
  const fd = openSync(file, 'a')
  try {
    writeSync(fd, `${JSON.stringify(entry)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
