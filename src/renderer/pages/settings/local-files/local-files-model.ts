// What the list of local files shows: where a file is and whether it is still there. Pure; ./local-files-view.ts draws it.
import type { LocalFileRow } from '../../../../main/privacy/local-files-domain.js'

export interface LocalFileLine {
  readonly name: string
  readonly where: string
  readonly missing: boolean
}

/** The file's name and the folder it lies in, split at the last separator of either kind. */
export function localFileLine (row: LocalFileRow): LocalFileLine {
  const at = Math.max(row.path.lastIndexOf('/'), row.path.lastIndexOf('\\'))
  return { name: row.path.slice(at + 1), where: at <= 0 ? row.path.slice(0, at + 1) : row.path.slice(0, at), missing: row.missing }
}

/** Main's answer to `list`, checked at the edge. */
export function isRows (value: unknown): value is { files: LocalFileRow[] } {
  if (typeof value !== 'object' || value === null) return false
  const files = (value as { files?: unknown }).files
  return Array.isArray(files) && files.every((file) => typeof file === 'object' && file !== null && typeof (file as LocalFileRow).id === 'string' && typeof (file as LocalFileRow).path === 'string' && typeof (file as LocalFileRow).missing === 'boolean')
}
