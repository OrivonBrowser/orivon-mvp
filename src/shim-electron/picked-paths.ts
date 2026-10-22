// The stand-in paths `dialog` hands an app for a file or folder the person picked,
// and the table that answers them. `src/shim/fs/` reads this table to route a call
// on such a path onto the pick's handle; README.md's Design notes say why the
// table lives here and why it is a module rather than a global.

import type { DirectoryHandle, FileHandle } from '../contracts/handles.js'

/** Every stand-in path starts here. Beside the app's own root (`/orivon/app`, src/shim/virtual-root.ts) and never inside it. */
export const PICKED_ROOT = '/orivon/picked'

export type PickedEntry =
  | { readonly kind: 'file', readonly id: string, readonly name: string, readonly handle: FileHandle }
  | { readonly kind: 'directory', readonly id: string, readonly handle: DirectoryHandle }

export type PickedResolution =
  /** `relative` is what follows `<root>/<id>`, normalised, with no leading slash: `''` for the pick's own folder. */
  | { readonly status: 'pick', readonly entry: PickedEntry, readonly relative: string }
  /** Under the picked root, but no pick has that id: it is from before a reload, or its handle was revoked or closed. */
  | { readonly status: 'stale', readonly id: string }
  /** The picked root itself, which lists nothing: an app holds the paths it was given. */
  | { readonly status: 'list' }

const picks = new Map<string, PickedEntry>()

function newId (): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A file name the person's file system gave, made safe to be one path segment. */
function segment (name: string): string {
  const cleaned = Array.from(name, (char) => (char === '/' || char === '\\' || char.charCodeAt(0) < 32 ? '_' : char)).join('')
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned
}

function keep (entry: PickedEntry): string {
  picks.set(entry.id, entry)
  // A page's handle carries no live `closed` yet, so there may be nothing to follow; when there is, a
  // handle that closed can answer nothing and its path then reads as stale instead of failing inside every call.
  const forget = (): void => { if (picks.get(entry.id) === entry) picks.delete(entry.id) }
  const closed = (entry.handle as { closed?: Promise<void> }).closed
  closed?.then(forget, forget)
  return `${PICKED_ROOT}/${entry.id}`
}

/** The stand-in path of a picked file: `<root>/<id>/<name>`. */
export function registerPickedFile (handle: FileHandle, name: string): string {
  const entry: PickedEntry = { kind: 'file', id: newId(), name: segment(name), handle }
  return `${keep(entry)}/${entry.name}`
}

/** The stand-in path of a picked folder: `<root>/<id>`. */
export function registerPickedDirectory (handle: DirectoryHandle): string {
  return keep({ kind: 'directory', id: newId(), handle })
}

/** Resolves `.` and `..` in an absolute path. A `..` at the top stays at the top, as in the kernel. */
function normalizeAbsolute (path: string): string {
  const kept: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') kept.pop()
    else kept.push(part)
  }
  return `/${kept.join('/')}`
}

/**
 * What `path` names among the picks, or `undefined` for any path outside the picked root. The path is normalised
 * before it is matched, so a `..` can leave a pick for the app's root or the list, and never reach another pick.
 */
export function resolvePickedPath (path: string): PickedResolution | undefined {
  if (!path.startsWith('/')) return undefined
  const normalized = normalizeAbsolute(path)
  if (normalized === PICKED_ROOT) return { status: 'list' }
  if (!normalized.startsWith(`${PICKED_ROOT}/`)) return undefined
  const rest = normalized.slice(PICKED_ROOT.length + 1)
  const slash = rest.indexOf('/')
  const id = slash === -1 ? rest : rest.slice(0, slash)
  const entry = picks.get(id)
  if (entry === undefined) return { status: 'stale', id }
  return { status: 'pick', entry, relative: slash === -1 ? '' : rest.slice(slash + 1) }
}
