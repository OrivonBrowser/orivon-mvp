// The extensions page's view model, built from a registry entry and the
// facts read off its manifest and locale catalogue -- pure (no `electron`,
// no `node:fs`, this directory's suffix rule): the reading of those files is
// `extensions-view-runner.ts`'s job, this file only decides what to show.
import { basename } from 'node:path'
import {
  describeHostAccess, describeStrippedPermissions, NOT_GRANTED_APPS_CLAUSE
} from '../../broker/policy/extension-manifest.js'
import type { ExtensionManifestFacts } from '../../broker/policy/extension-manifest.js'
import { describeUpdater } from './registry.js'
import type { ExtensionSource, InstalledExtension } from './registry.js'

/** What every website and Web3 site an installed extension can reach, and
 * cannot -- the same clause `describeExtensionInstall`'s Web3 line closes
 * with, so the install prompt and this page never disagree. */
export const WHERE_EXTENSIONS_RUN = `Every website and Web3 site, not ${NOT_GRANTED_APPS_CLAUSE}.`

export interface ExtensionRow {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description: string
  readonly enabled: boolean
  /** A `data:` URL, or undefined when the manifest names no icon `extensions-view-runner.ts` could read. */
  readonly iconDataUrl: string | undefined
}

export interface ExtensionDetails {
  readonly id: string
  readonly source: string
  readonly updates: string
  readonly siteAccess: string | undefined
  readonly stripped: readonly string[]
  readonly whereItRuns: string
  /** True for an unpacked install: the page offers Reload only then. */
  readonly reloadable: boolean
}

/** What `extensions-view-runner.ts` read off disk for one entry: the
 * manifest facts (undefined if its manifest.json could not be read or
 * parsed, which the page shows as missing detail rather than failing), and
 * the name/description/icon already resolved to what a person reads. */
export interface ExtensionFacts {
  readonly resolvedName: string
  readonly resolvedDescription: string | undefined
  readonly iconDataUrl: string | undefined
  readonly manifestFacts: ExtensionManifestFacts | undefined
}

export function describeSource (source: ExtensionSource): string {
  switch (source.kind) {
    case 'unpacked': return `Unpacked folder ${source.from}`
    case 'file': return `File ${basename(source.fileName)}`
    case 'store': return 'Chrome Web Store'
  }
}

export interface IconChoice {
  readonly size: number
  readonly path: string
}

/** The best of `icons` at `maxSize` px or smaller; when none qualifies, the
 * smallest one there is, since some icon beats none. `icons` is manifest.json's
 * own `icons` object, sizes as string keys ("16", "48", "128"). */
export function pickIconPath (icons: Readonly<Record<string, unknown>> | undefined, maxSize: number): IconChoice | undefined {
  if (icons === undefined) return undefined
  const sized: IconChoice[] = []
  for (const [key, value] of Object.entries(icons)) {
    const size = Number(key)
    if (Number.isFinite(size) && size > 0 && typeof value === 'string') sized.push({ size, path: value })
  }
  if (sized.length === 0) return undefined
  const eligible = sized.filter((entry) => entry.size <= maxSize)
  if (eligible.length > 0) return eligible.reduce((best, entry) => (entry.size > best.size ? entry : best))
  return sized.reduce((best, entry) => (entry.size < best.size ? entry : best))
}

const ICON_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

export function iconMimeType (path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? 'application/octet-stream' : ICON_MIME[path.slice(dot).toLowerCase()] ?? 'application/octet-stream'
}

const MSG_PATTERN = /^__MSG_([A-Za-z0-9_@]+)__$/

/** `raw` as Chrome's manifest grammar defines it: a literal string, or a
 * `__MSG_<name>__` reference into `catalog` (keyed lower-case, since message
 * names are matched case-insensitively) -- unresolved references, and a
 * literal with no `__MSG_` shape at all, pass through unchanged. */
export function resolveLocaleMessage (raw: string, catalog: ReadonlyMap<string, string> | undefined): string {
  const match = MSG_PATTERN.exec(raw)
  if (match === null) return raw
  const key = (match[1] as string).toLowerCase()
  return catalog?.get(key) ?? raw
}

export function findExtension (entries: readonly InstalledExtension[], id: unknown): InstalledExtension | undefined {
  return typeof id === 'string' ? entries.find((entry) => entry.id === id) : undefined
}

export function buildExtensionRow (entry: InstalledExtension, facts: ExtensionFacts): ExtensionRow {
  return {
    id: entry.id,
    name: facts.resolvedName,
    version: entry.version,
    description: facts.resolvedDescription ?? '',
    enabled: entry.enabled,
    iconDataUrl: facts.iconDataUrl
  }
}

export function buildExtensionDetails (entry: InstalledExtension, facts: ExtensionFacts): ExtensionDetails {
  return {
    id: entry.id,
    source: describeSource(entry.source),
    updates: describeUpdater(entry),
    siteAccess: facts.manifestFacts === undefined ? undefined : describeHostAccess(facts.manifestFacts),
    stripped: describeStrippedPermissions(entry.stripped),
    whereItRuns: WHERE_EXTENSIONS_RUN,
    reloadable: entry.source.kind === 'unpacked'
  }
}
