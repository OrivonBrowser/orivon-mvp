// The preview1 conformance suite's programs (WebAssembly/wasi-testsuite),
// each with its expected exit code and output, as both hosts' conformance
// tests run them.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const LANGUAGES = ['assemblyscript', 'c', 'rust'] as const

/** Programs that fail for a reason outside the host: each needs something orivon.fs does not have. */
export const KNOWN_FAILURES: Readonly<Record<string, string>> = {
  'rust/fd_filestat_set': 'sets file times',
  'rust/path_filestat': 'sets file times',
  'rust/nofollow_errors': 'creates a symbolic link',
  'rust/path_exists': 'creates a symbolic link',
  'rust/path_link': 'creates a hard link',
  'rust/path_symlink_trailing_slashes': 'creates a symbolic link',
  'rust/readlink': 'creates a symbolic link',
  'rust/symlink_create': 'creates a symbolic link',
  'rust/symlink_filestat': 'creates a symbolic link'
}

export interface Spec {
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly root?: string
  readonly exit_code?: number
  readonly stdout?: string
}

export interface Program { readonly name: string, readonly dir: string, readonly file: string, readonly spec: Spec }

export function programs (suite: string): Program[] {
  return LANGUAGES.flatMap((language) => {
    const dir = join(suite, 'tests', language, 'testsuite', 'wasm32-wasip1')
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((file) => file.endsWith('.wasm')).sort().map((file) => {
      const specPath = join(dir, file.replace(/\.wasm$/, '.json'))
      const spec = existsSync(specPath) ? JSON.parse(readFileSync(specPath, 'utf8')) as Spec : {}
      return { name: `${language}/${file.replace(/\.wasm$/, '')}`, dir, file, spec }
    })
  })
}
