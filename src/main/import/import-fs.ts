// What the detector and the readers need from the file system, as a seam: the real one reads, and never
// writes, other browsers' files; a test hands in a map of files.
import { readdir, realpath, stat, open } from 'node:fs/promises'

export interface ImportFs {
  /** The file's text, or `undefined` when it is missing, is not a file, or is larger than `maxBytes`. */
  readText: (path: string, maxBytes: number) => Promise<string | undefined>
  /** The names of the directories inside `path`; empty when there are none or it cannot be read. */
  listDirs: (path: string) => Promise<string[]>
  isFile: (path: string) => Promise<boolean>
  /** The path with its links resolved, or `undefined` when nothing is there. */
  realPath: (path: string) => Promise<string | undefined>
}

export const nodeImportFs: ImportFs = {
  readText: async (path, maxBytes) => {
    try {
      const handle = await open(path, 'r')
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size > maxBytes) return undefined
        return await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
    } catch {
      return undefined
    }
  },
  listDirs: async (path) => {
    try {
      return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name)
    } catch {
      return []
    }
  },
  isFile: async (path) => {
    try {
      return (await stat(path)).isFile()
    } catch {
      return false
    }
  },
  realPath: async (path) => {
    try {
      return await realpath(path)
    } catch {
      return undefined
    }
  }
}
