// The bundle hash tree a site publishes about itself (ADR-0029): read,
// never trusted to decide anything here. fetch/bundle.ts hands it on
// beside the tree it computed, and src/trust/ddoc.ts compares the two.
// An unreadable or missing file is `undefined` ("not published"), never a
// failed fetch: the bundle loads either way.

import { MAX_BUNDLE_ENTRIES, isValidCanonicalPath } from '../broker/policy/canonical-path.js'
import type { PathLeaf } from '../broker/policy/canonical-path.js'
import { isString, ownProperty } from '../broker/policy/own-property.js'
import { BUNDLE_HASH_PATTERN } from '../broker/policy/pin.js'
import { fetchWithBudget, joinChunks } from './fetch/budget.js'
import type { ByteBudget, Fetch } from './fetch/budget.js'

/** Beside the manifest, and never a leaf: a root cannot describe the file that holds it. */
export const DDOC_PATH = '/.well-known/orivon-ddoc.json'

/**
 * One line per leaf, for a 56-byte path (manifest.ts's ASSET_LINE_BYTES
 * assumption) plus its quoted digest and indentation, and one kilobyte for
 * the rest: 656,384 bytes.
 */
const LEAF_LINE_BYTES = 160
export const MAX_DDOC_BYTES = MAX_BUNDLE_ENTRIES * LEAF_LINE_BYTES + 1024

export interface DdocDeclaration {
  readonly bundleHash: string
  readonly leaves: readonly PathLeaf[]
}

/** The published JSON value, or a stored copy of it, read as untrusted input. Never throws. */
export function parseDdocDeclaration (raw: unknown): DdocDeclaration | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const bundleHash = ownProperty(raw, 'bundleHash', isString)
  if (bundleHash === undefined || !BUNDLE_HASH_PATTERN.test(bundleHash)) return undefined
  const table = ownProperty(raw, 'leaves', isPlainObject)
  if (table === undefined) return undefined
  const entries = Object.entries(table)
  if (entries.length === 0 || entries.length > MAX_BUNDLE_ENTRIES) return undefined
  const leaves: PathLeaf[] = []
  for (const [path, leaf] of entries) {
    if (!isValidCanonicalPath(path) || typeof leaf !== 'string' || !BUNDLE_HASH_PATTERN.test(leaf)) return undefined
    leaves.push({ path, leaf })
  }
  return { bundleHash, leaves }
}

/** The published shape, for storing a declaration so parseDdocDeclaration reads it back unchanged. */
export function ddocToJson (declaration: DdocDeclaration): { bundleHash: string, leaves: Record<string, string> } {
  const leaves: Record<string, string> = {}
  for (const { path, leaf } of declaration.leaves) leaves[path] = leaf
  return { bundleHash: declaration.bundleHash, leaves }
}

/**
 * `undefined` for anything short of a well-formed file: a 404, a network
 * error, an over-cap body, or a host that answers every missing path with
 * its index page. Only a body that arrived and failed to parse is logged,
 * since the other cases are simply a site that publishes nothing.
 */
export async function fetchDdocDeclaration (
  fetchFn: Fetch,
  canonicalOrigin: string,
  pinnedAddresses: readonly string[],
  budget: ByteBudget,
  bundleSignal: AbortSignal
): Promise<DdocDeclaration | undefined> {
  const url = `${canonicalOrigin}${DDOC_PATH}`
  const chunks: Uint8Array[] = []
  const fetched = await fetchWithBudget(fetchFn, url, pinnedAddresses, MAX_DDOC_BYTES, budget, 'DDOC hash tree', bundleSignal,
    async (chunk) => { chunks.push(chunk) })
  if ('ok' in fetched) return undefined

  const text = new TextDecoder('utf-8', { fatal: false }).decode(joinChunks(chunks, fetched.byteLength))
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    raw = undefined
  }
  const declaration = parseDdocDeclaration(raw)
  if (declaration === undefined) {
    const hint = text.trimStart().startsWith('<') ? ' (the host answered with an HTML page, as hosts that serve their index for any missing path do)' : ''
    console.info(`[loader] ${canonicalOrigin} serves ${DDOC_PATH}, but not as a readable DDOC hash tree${hint}; treated as not published`)
  }
  return declaration
}

function isPlainObject (v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
