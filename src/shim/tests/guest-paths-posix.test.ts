import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The shim handles guest paths (the virtual root '/orivon/app', a WASI open-at
// name). In an app's renderer a bare `path` is the POSIX polyfill, but the
// local nodes run the shim in a Node utility process, where it is Node's own:
// win32 on Windows, which turns '/orivon/app' into '\orivon\app'. Vitest
// aliases `path` to the polyfill too, so only the import itself can be checked
// here: `path/posix` is POSIX under both.

const SHIM = dirname(dirname(fileURLToPath(import.meta.url)))
const HOST_SIDE = ['bundler']
/** The alias table names the module as data, in prose. */
const NAMES_MODULES_AS_DATA = ['module-map.ts']

const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function sources (directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'tests' || entry.name === 'node_modules' || (directory === SHIM && HOST_SIDE.includes(entry.name)) ? [] : sources(full)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : []
  })
}

/** Every form that names the bare module: `from 'path'` (also over several lines), `import 'path'`, `require('path')`, `import('path')`, with or without `node:`. */
const BARE_PATH = /\b(?:from|import|require)\s*\(?\s*['"`](?:node:)?path['"`]/

describe('the shim\'s path handling', () => {
  it('imports only the POSIX path module, whatever platform the host runs on', () => {
    const offenders = sources(SHIM).filter((file) => !NAMES_MODULES_AS_DATA.includes(relative(SHIM, file)) && BARE_PATH.test(withoutComments(readFileSync(file, 'utf8'))))
    expect(offenders.map((file) => relative(SHIM, file))).toEqual([])
  })

  it('recognises every form of the bare module, and not path/posix', () => {
    const bare = [
      "import { join } from 'path'",
      'import {\n  join,\n  normalize\n} from "node:path"',
      "import 'path'",
      "import 'node:path'",
      "const path = require('path')",
      'const path = require( "node:path" )',
      "import path = require('path')",
      "const path = await import('path')",
      'const path = await import(`node:path`)',
      "export { join } from 'path'"
    ]
    for (const source of bare) expect(BARE_PATH.test(source), source).toBe(true)
    for (const source of ["import { join } from 'path/posix'", "require('path/posix')", "import('node:path/posix')", "const x = 'pathology'"]) expect(BARE_PATH.test(source), source).toBe(false)
  })
})
