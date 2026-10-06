// What the Settings page may ask about local files: the files a person let use Orivon permissions, which of them are
// gone from the disk, deleting one's data, and clearing what every other local file keeps together. A file is named by
// an id this domain made for the list it sent, so a crafted message cannot reach a file that was never shown.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { originHash } from '../../broker/grants/origin-hash.js'
import type { InternalDomain } from '../pages/internal-ipc.js'

export interface LocalFilesDomainDeps {
  /** The keys of the recorded files. */
  readonly list: () => readonly string[]
  readonly exists?: (path: string) => boolean
  /** Deletes one file's grants, session, saved files and record (`../local-files/delete-local-file-data.ts`). */
  readonly deleteFile: (key: string) => Promise<boolean>
  /** Clears the session every unrecorded local file shares. */
  readonly clearShared: () => Promise<void>
  readonly platform?: NodeJS.Platform
}

export interface LocalFileRow {
  readonly id: string
  readonly path: string
  readonly missing: boolean
}

export function localFilesDomain (deps: LocalFilesDomainDeps): InternalDomain {
  const exists = deps.exists ?? existsSync
  const platform = deps.platform ?? process.platform
  let listed = new Map<string, string>()

  return {
    pages: ['settings'],
    handle: async (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as { type?: unknown, id?: unknown }
      switch (request.type) {
        case 'list': {
          const rows: LocalFileRow[] = []
          listed = new Map()
          for (const key of deps.list()) {
            let path: string
            try {
              path = fileURLToPath(key, { windows: platform === 'win32' })
            } catch {
              continue
            }
            const id = originHash(key).slice(0, 16)
            listed.set(id, key)
            rows.push({ id, path, missing: !exists(path) })
          }
          return { files: rows }
        }
        case 'delete': {
          const key = typeof request.id === 'string' ? listed.get(request.id) : undefined
          return key === undefined ? undefined : { ok: await deps.deleteFile(key) }
        }
        case 'clearShared':
          await deps.clearShared()
          return { ok: true }
        default:
          return undefined
      }
    }
  }
}
