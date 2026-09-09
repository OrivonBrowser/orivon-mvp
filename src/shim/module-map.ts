// The single table electron.vite.config.ts's renderer.resolve.alias map is
// built from. Adding an approved dependency, or a hand-written polyfill,
// becomes editing one row here and nothing in the build config -- the point
// of this file, not a nicety: this repo has zero runtime dependencies today,
// and every "ready, package" row below is currently hypothetical, waiting
// on an owner decision (docs/planning/shim-dependency-review.md).
//
// Pure data plus a pure transform: no `node:*` import here, on purpose, so
// this stays testable and reviewable independent of how paths eventually
// get resolved to absolute ones (electron.vite.config.ts's job, since it
// already has `root`).

export type ShimModuleStatus = 'ready' | 'pending-dependency'

export interface ShimModuleEntry {
  readonly specifier: string
  readonly status: ShimModuleStatus
  /** Only meaningful when `status` is 'ready'. 'local': implementation is a path relative to src/shim/. 'package': implementation is an npm package name. */
  readonly kind?: 'local' | 'package'
  readonly implementation?: string
  readonly note: string
}

const REVIEW = 'docs/planning/shim-dependency-review.md'

export const SHIM_MODULE_MAP: readonly ShimModuleEntry[] = [
  { specifier: 'util', status: 'ready', kind: 'local', implementation: './node-util.js', note: 'Hand-written, inherits-only -- the only confirmed live caller in the Phase 5 dependency trees. See node-util.ts.' },
  { specifier: 'electron', status: 'ready', kind: 'local', implementation: '../shim-electron/index.js', note: 'Owned by a sibling stream (src/shim-electron/); this stream owns the alias map, so the entry lives here rather than there.' },
  { specifier: 'buffer', status: 'pending-dependency', note: `Confirmed essential (bencode/safe-buffer). Reviewed in ${REVIEW}, awaiting owner approval.` },
  { specifier: 'events', status: 'pending-dependency', note: `Confirmed essential (k-bucket, k-rpc-socket, webtorrent's own import). Reviewed in ${REVIEW}, awaiting owner approval.` },
  { specifier: 'path', status: 'pending-dependency', note: `Confirmed essential (webtorrent's own \`import path from 'path'\`). Reviewed in ${REVIEW}, awaiting owner approval.` },
  { specifier: 'stream', status: 'pending-dependency', note: `Confirmed essential, transitively (crypto-browserify's Hash extends stream.Transform). Reviewed in ${REVIEW}, awaiting owner approval.` },
  { specifier: 'crypto', status: 'pending-dependency', note: `Confirmed essential (bittorrent-protocol's mse.js: DH key exchange, sha1). Reviewed in ${REVIEW}, awaiting owner approval.` },
  { specifier: 'os', status: 'pending-dependency', note: `On the compatibility-matrix.md floor; no live caller confirmed in this pass. Reviewed in ${REVIEW}, recommends deferring.` },
  { specifier: 'zlib', status: 'pending-dependency', note: `Recon-flagged (FreeTube's main process, brotli); no live caller confirmed in the Node lane, and no mature pure-JS brotli codec exists. Reviewed in ${REVIEW}, recommends deferring.` }
]

export interface ShimAliasEntry {
  readonly specifier: string
  readonly kind: 'local' | 'package'
  readonly implementation: string
}

/** Every 'ready' row, in the shape electron.vite.config.ts resolves into its alias map. Silently drops every 'pending-dependency' row -- there is nothing yet to point an alias at. */
export function buildAliasEntries (): readonly ShimAliasEntry[] {
  const entries: ShimAliasEntry[] = []
  for (const entry of SHIM_MODULE_MAP) {
    if (entry.status !== 'ready' || entry.kind === undefined || entry.implementation === undefined) continue
    entries.push({ specifier: entry.specifier, kind: entry.kind, implementation: entry.implementation })
  }
  return entries
}
