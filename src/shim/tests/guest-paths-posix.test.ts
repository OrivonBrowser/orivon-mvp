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

function sources (directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'tests' || entry.name === 'node_modules' || (directory === SHIM && HOST_SIDE.includes(entry.name)) ? [] : sources(full)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : []
  })
}

describe('the shim\'s path handling', () => {
  it('imports only the POSIX path module, whatever platform the host runs on', () => {
    const offenders = sources(SHIM).filter((file) => /^\s*(?:import|export)\b[^'"\n]*\bfrom\s+['"](?:node:)?path['"]/m.test(readFileSync(file, 'utf8')))
    expect(offenders.map((file) => relative(SHIM, file))).toEqual([])
  })
})
