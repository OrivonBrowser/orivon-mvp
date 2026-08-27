// Shared fixtures for bundle-hash.test.ts and canonical-path.test.ts (split
// out of one file, docs/development/code-guidelines.md Rule 2). Not
// *.test.ts, so vitest does not collect it as its own suite.

import { MANIFEST_PATH } from './canonical-path.js'
import type { BundleEntry } from './bundle-hash.js'

export function utf8 (text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function manifestEntry (content = '{"orivonApiVersion":0}'): BundleEntry {
  return { path: MANIFEST_PATH, content: utf8(content) }
}
