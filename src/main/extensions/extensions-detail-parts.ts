// Where a feature adds what the extensions page shows for it: one function per
// feature, each answering a plain object the page's own section or badge
// reads (renderer/pages/extensions/registry.ts). Pure -- a part may call into
// `deps`, but this file imports nothing from electron.
import type { ExtensionFacts } from './extensions-view.js'
import type { ExtensionsDomainDeps } from './extensions-domain.js'
import type { InstalledExtension } from './registry.js'
import { optionalPart } from './details-optional.js'
import { shortcutsPart } from './shortcuts-page.js'

export type ExtensionPart = (entry: InstalledExtension, facts: ExtensionFacts, deps: ExtensionsDomainDeps) => Record<string, unknown>

/** Merged into `ExtensionDetails.parts` of the details reply. One per line, alphabetical. */
export const DETAIL_PARTS: ReadonlyArray<ExtensionPart> = [
  optionalPart,
  shortcutsPart
]

/** Merged into `ExtensionRow.parts` of every list row. One per line, alphabetical. */
export const ROW_PARTS: ReadonlyArray<ExtensionPart> = []

export function mergeParts (parts: ReadonlyArray<ExtensionPart>, entry: InstalledExtension, facts: ExtensionFacts, deps: ExtensionsDomainDeps): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const part of parts) Object.assign(merged, part(entry, facts, deps))
  return merged
}
