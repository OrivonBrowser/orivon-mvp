// A file system for the detector and the readers: a map of paths to text, where a path may be a link to another.
import type { ImportFs } from '../import-fs.js'

export function fakeFs (files: Record<string, string>, links: Record<string, string> = {}): ImportFs {
  const real = (path: string): string => {
    for (const [from, to] of Object.entries(links)) if (path === from || path.startsWith(`${from}/`)) return to + path.slice(from.length)
    return path
  }
  const paths = Object.keys(files)
  const isDir = (path: string): boolean => paths.some((file) => file.startsWith(`${path}/`))
  return {
    readText: async (path, max) => {
      const text = files[real(path)]
      return text === undefined || text.length > max ? undefined : text
    },
    listDirs: async (path) => {
      const at = real(path)
      const names = new Set<string>()
      for (const file of paths) if (file.startsWith(`${at}/`)) names.add(file.slice(at.length + 1).split('/')[0] as string)
      return [...names].filter((name) => isDir(`${at}/${name}`))
    },
    isFile: async (path) => files[real(path)] !== undefined,
    realPath: async (path) => {
      const at = real(path)
      return files[at] !== undefined || isDir(at) ? at : undefined
    }
  }
}
