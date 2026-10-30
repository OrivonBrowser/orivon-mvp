// The order a bundle's declared files are downloaded in: the entry, then the files the pages
// read so far lead to, then the rest as the manifest lists them. What a file says can only move
// a path the manifest declares towards the front; why the order exists: README.md, Design notes.

import { canonicalAssetPath } from '../../broker/policy/canonical-path.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { resolveUrl } from './asset.js'
import { joinChunks } from './budget.js'

/** The most bytes of one file that are read for the paths it names; a larger file is not read. */
export const MAX_SCANNED_BYTES = 1024 * 1024

/** The most files read for the paths they name, so the cost on the main process has a ceiling. */
export const MAX_SCANNED_FILES = 32

const SCANNABLE = /\.(?:html?|m?js|css)$/i
const EXTENSION = /\.[A-Za-z0-9]{1,16}$/
/**
 * A run of path characters. Deliberately without the extension: a pattern that demands `\.\w+` after
 * a greedy run backtracks quadratically on a long run with no dot, and a data URI is one.
 */
const TOKEN = /[^\s"'`<>()[\]{}\\|,;:?#!=*^&]+/g
const MAX_TOKEN_LENGTH = 300

/** The decoded and the percent-encoded spelling of the last segment of a canonical path, when it has an extension. */
function namesOf (canonical: string): string[] {
  const encoded = canonical.slice(canonical.lastIndexOf('/') + 1)
  if (!EXTENSION.test(encoded)) return []
  try {
    return [encoded, decodeURIComponent(encoded)]
  } catch {
    return [encoded]
  }
}

export class ReadOrder {
  readonly #origin: string
  readonly #count: number
  readonly #keys: Array<string | null> = []
  /** Canonical path -> index, for each file neither handed out nor promoted yet: the only things a mention can select. */
  readonly #waiting = new Map<string, number>()
  /** Every last segment a mention could end in, so a token that cannot name a declared file costs no URL parsing. */
  readonly #names = new Set<string>()
  readonly #taken: boolean[] = []
  readonly #reached: boolean[] = []
  readonly #promoted: number[] = []
  #promotedHead = 0
  #cursor = 0
  #scanned = 0

  /** `paths` as the manifest declares them, the entry first. */
  constructor (canonicalOrigin: string, paths: readonly string[]) {
    this.#origin = canonicalOrigin
    this.#count = paths.length
    paths.forEach((path, index) => {
      const resolved = resolveUrl(path, `${canonicalOrigin}/`)
      const key = resolved === null ? null : canonicalAssetPath(resolved)
      this.#keys.push(key)
      this.#taken.push(false)
      this.#reached.push(index === 0)
      if (key === null) return
      if (!this.#waiting.has(key)) this.#waiting.set(key, index)
      for (const name of namesOf(key)) this.#names.add(name)
    })
  }

  /** The index of the next file to download, once each: a promoted one, else the first the manifest lists that is still waiting. */
  take (): number | undefined {
    let index = this.#promoted[this.#promotedHead]
    if (index !== undefined) {
      this.#promotedHead += 1
    } else {
      while (this.#cursor < this.#count && this.#taken[this.#cursor] === true) this.#cursor += 1
      if (this.#cursor >= this.#count) return undefined
      index = this.#cursor
    }
    this.#taken[index] = true
    const key = this.#keys[index]
    if (key !== null && key !== undefined && this.#waiting.get(key) === index) this.#waiting.delete(key)
    return index
  }

  /**
   * Whether the file at `index`, of `byteLength` bytes, is to be read for the paths it names, counting it if so. A file
   * is read only when the entry led to it, its name says text, and it is small: the bulk of a bundle is neither.
   */
  reserveScan (index: number, byteLength: number): boolean {
    if (this.#reached[index] !== true || byteLength > MAX_SCANNED_BYTES || this.#scanned >= MAX_SCANNED_FILES) return false
    const key = this.#keys[index]
    if (key === null || key === undefined || !SCANNABLE.test(key)) return false
    this.#scanned += 1
    return true
  }

  /** Moves each file still waiting that `bytes` (the file at `index`) names to the back of the promoted ones, in the order found. */
  noteMentions (index: number, bytes: Uint8Array): void {
    const key = this.#keys[index]
    if (key === null || key === undefined || this.#waiting.size === 0) return
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const folder = `${this.#origin}${key}`
    const seen = new Set<string>()
    for (const match of text.matchAll(TOKEN)) {
      let token = match[0]
      if (token.length > MAX_TOKEN_LENGTH) continue
      while (token.endsWith('.')) token = token.slice(0, -1)
      if (!this.#names.has(token.slice(token.lastIndexOf('/') + 1)) || seen.has(token)) continue
      seen.add(token)
      for (const base of [folder, `${this.#origin}/`]) this.#promote(token, base)
      if (this.#waiting.size === 0) return
    }
  }

  #promote (token: string, base: string): void {
    const resolved = resolveUrl(token, base)
    if (resolved === null || originFromUrl(resolved) !== this.#origin) return
    const canonical = canonicalAssetPath(resolved)
    const found = canonical === null ? undefined : this.#waiting.get(canonical)
    if (found === undefined || canonical === null) return
    this.#waiting.delete(canonical)
    this.#promoted.push(found)
    this.#reached[found] = true
  }
}

/** The first `limit` bytes of `chunks`, read no further than that. */
export async function collectForScan (chunks: AsyncIterable<Uint8Array>, limit: number = MAX_SCANNED_BYTES): Promise<Uint8Array> {
  const kept: Uint8Array[] = []
  let total = 0
  for await (const chunk of chunks) {
    const used = Math.min(chunk.length, limit - total)
    kept.push(chunk.subarray(0, used))
    total += used
    if (total >= limit) break
  }
  return joinChunks(kept, total)
}
