// A publisher-side warning, never an inference (ADR-0011: the manifest
// declares its own files; the loader never adds to that list). An entry
// document that loads a same-origin script, stylesheet or image its
// manifest does not declare installs cleanly and then renders blank: that
// file is not pinned, so the cache refuses it. Naming those files in the
// log at install is what makes that failure findable.

import type { Manifest } from '../contracts/index.js'
import type { BundleTree } from '../broker/policy/bundle-hash.js'
import { canonicalAssetPath } from '../broker/policy/canonical-path.js'
import { originFromUrl } from '../broker/policy/origin.js'
import { entryCanonicalPath } from './fetch-bundle.js'
import type { LoaderStorage } from './storage.js'

/** `src`/`href` on the elements that load a subresource. `<a href>` is a navigation, not an asset, and is left out. */
const SUBRESOURCE = /<(?:script|link|img|source|video|audio|track|iframe|embed)\b[^>]*?\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi

/** The same-origin canonical paths `html` (served at `documentUrl`) loads that are not in `pinned`, sorted. */
export function undeclaredReferences (html: string, documentUrl: string, pinned: ReadonlySet<string>): string[] {
  const origin = originFromUrl(documentUrl)
  const found = new Set<string>()
  for (const match of html.matchAll(SUBRESOURCE)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (raw === '' || /^(?:data|blob|javascript|about):/i.test(raw)) continue
    let resolved: string
    try {
      resolved = new URL(raw, documentUrl).href
    } catch {
      continue
    }
    if (originFromUrl(resolved) !== origin) continue
    const path = canonicalAssetPath(resolved)
    if (path === null || path === '/' || pinned.has(path)) continue
    found.add(path)
  }
  return [...found].sort()
}

/** Logs the entry document's undeclared same-origin subresources, if any. Never throws: a warning must not fail an install. */
export async function warnUndeclaredReferences (storage: LoaderStorage, origin: string, manifest: Manifest, tree: BundleTree): Promise<void> {
  try {
    const entryPath = entryCanonicalPath(origin, manifest.entry)
    if (entryPath === null) return
    const bytes = await storage.readAsset(origin, entryPath)
    if (bytes === undefined) return
    const missing = undeclaredReferences(new TextDecoder().decode(bytes), `${origin}${entryPath}`, new Set(tree.assets.map((asset) => asset.path)))
    if (missing.length === 0) return
    console.warn(`[loader] ${origin}'s entry document loads ${String(missing.length)} same-origin file(s) its manifest's "assets" does not declare; they are not pinned and will not be served: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', ...' : ''}`)
  } catch (error) {
    console.error('[loader] could not check the entry document for undeclared assets', origin, error)
  }
}
