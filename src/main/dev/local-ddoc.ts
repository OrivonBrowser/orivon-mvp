// The bundle hash of the DDOC hash tree a local origin serves, in developer
// mode only (`ADR-0029`). A loopback address or a developer
// `.eth` name has no domain record, neither DNS nor an ENS contenthash, that
// could anchor its tree, so the tree it serves is taken as its DDOC
// (`../../trust/ddoc.ts`'s `local-dev`) and no file is compared against it.
// The Web3 Score page names that assumption wherever it shows, and a Web3
// Score provider is asked about that hash. Outside developer mode, and for
// any origin that is not local, there is no answer and no fetch.

import { DDOC_PATH, MAX_DDOC_BYTES, parseDdocDeclaration } from '../../loader/ddoc-declaration.js'
import { readCapped } from '../browsing/favicon-fetch.js'
import { grantableWithoutInstall } from '../install/grant-without-install.js'
import { devModeEnabled } from './dev-mode.js'

const FETCH_TIMEOUT_MS = 2_000

export interface LocalDdocDeps {
  readonly devMode: boolean
  /** The body at `url`, or null past `cap` bytes or on any failure. Never throws. */
  readonly fetchCapped: (url: string, cap: number) => Promise<Uint8Array | null>
}

/** The bundle hash the tree declares, or undefined when there is none to read. "Local" is exactly the
 * set of origins Orivon grants without installing, which is why none of them has a pin to compare. */
export async function localDdocHash (origin: string, deps: LocalDdocDeps): Promise<string | undefined> {
  if (!deps.devMode || !grantableWithoutInstall(origin, true)) return undefined
  const body = await deps.fetchCapped(`${origin}${DDOC_PATH}`, MAX_DDOC_BYTES)
  if (body === null) return undefined
  try {
    return parseDdocDeclaration(JSON.parse(new TextDecoder().decode(body)))?.bundleHash
  } catch {
    return undefined
  }
}

/** The shell asks on every state push, several a second while a page loads; asks this close together share one fetch. */
const REUSE_MS = 2_000
const recent = new Map<string, { readonly at: number, readonly answer: Promise<string | undefined> }>()

export async function localDdocHashFor (origin: string): Promise<string | undefined> {
  const now = Date.now()
  const hit = recent.get(origin)
  if (hit !== undefined && now - hit.at < REUSE_MS) return await hit.answer
  for (const [key, entry] of recent) if (now - entry.at >= REUSE_MS) recent.delete(key)
  const answer = localDdocHash(origin, { devMode: devModeEnabled(), fetchCapped: netFetchCapped })
  recent.set(origin, { at: now, answer })
  return await answer
}

// net.fetch, not Node's fetch: only Chromium's resolver honours the
// --host-resolver-rules that map a developer `.eth` name to loopback.
// Imported dynamically, as favicon-fetch.ts's header explains.
async function netFetchCapped (url: string, cap: number): Promise<Uint8Array | null> {
  const { net } = await import('electron')
  try {
    const response = await net.fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) return null
    return await readCapped(response.body, cap)
  } catch {
    return null
  }
}
