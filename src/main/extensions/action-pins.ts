// Which extensions sit on the toolbar and in what order the Extensions menu
// lists them -- pure: no `electron`, no store. `extension-prefs.ts` holds the
// choice, `action-pins-runner.ts` acts on it.
import type { ExtensionPrefs } from './extension-prefs.js'

/** A person's own choice wins; an extension they never chose for follows the `extensions.pinNew` setting. */
export function isPinned (prefs: Pick<ExtensionPrefs, 'pinned'>, pinNew: boolean): boolean {
  return prefs.pinned ?? pinNew
}

/** Pinned first, then by name; two names that differ only in case keep the order they came in. */
export function sortRows<T extends { readonly pinned: boolean, readonly name: string }> (rows: readonly T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (a.row.pinned !== b.row.pinned) return a.row.pinned ? -1 : 1
      return a.row.name.localeCompare(b.row.name, undefined, { sensitivity: 'base' }) || a.index - b.index
    })
    .map(({ row }) => row)
}
