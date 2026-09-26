// `path` and `path/posix` module target (module-map.ts): path-browserify,
// which is POSIX path handling, with `posix` pointing back at this same
// module. path.win32 is absent; it refuses by name when called.

import pathBrowserify from 'path-browserify'
import { nodeModule } from './module-proxy.js'

export const {
  basename, delimiter, dirname, extname, format, isAbsolute, join, normalize, parse, relative, resolve, sep
} = pathBrowserify

export function toNamespacedPath (path: string): string { return path }

const members = { basename, delimiter, dirname, extname, format, isAbsolute, join, normalize, parse, relative, resolve, sep, toNamespacedPath }
const path: typeof members & { posix?: unknown } = nodeModule('path', members)
Object.assign(members, { posix: path })

export const posix = path
export default path
