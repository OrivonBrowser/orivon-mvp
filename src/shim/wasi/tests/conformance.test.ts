// The preview1 conformance suite (WebAssembly/wasi-testsuite): real C,
// Rust and AssemblyScript programs, each with its expected exit code and
// output, run against the host over a real temporary directory. Opt-in: the
// suite's binaries are not in this repository, so this skips unless
// ORIVON_WASI_TESTSUITE names a checkout of its prebuilt branch:
//
//   git clone --depth 1 -b prod/testsuite-base https://github.com/WebAssembly/wasi-testsuite <dir>
//   ORIVON_WASI_TESTSUITE=<dir> npx vitest run src/shim/wasi/tests/conformance.test.ts
//
// Last run against 609c446139956ff30239f87cb18af1dc6128bed2: 63 of 72 pass.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRealDiskFs } from '../../tests/support/real-disk-fs.js'
import { createWasiHost } from '../host.js'
import { runEntry, suspendingImports } from '../instantiate.js'
import { hasJspi, jspiWebAssembly } from './support/jspi.js'

const SUITE = process.env.ORIVON_WASI_TESTSUITE
const LANGUAGES = ['assemblyscript', 'c', 'rust'] as const

/** Programs that fail for a reason outside the host: each needs something orivon.fs does not have. */
const KNOWN_FAILURES: Readonly<Record<string, string>> = {
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

interface Spec {
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly root?: string
  readonly exit_code?: number
  readonly stdout?: string
}

interface Program { readonly name: string, readonly dir: string, readonly file: string, readonly spec: Spec }

function programs (suite: string): Program[] {
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

async function run (program: Program): Promise<{ code: number, stdout: string }> {
  const disk = await createRealDiskFs()
  try {
    if (program.spec.root !== undefined) await cp(join(program.dir, program.spec.root), disk.root, { recursive: true })
    let stdout = ''
    const host = createWasiHost({
      fs: disk.orivon.fs,
      args: [program.file, ...(program.spec.args ?? [])],
      env: program.spec.env ?? {},
      preopens: program.spec.root === undefined ? {} : { '/': '/orivon/app' },
      stdout: (bytes) => { stdout += new TextDecoder().decode(bytes) },
      stderr: () => {}
    })
    const module = new jspiWebAssembly.Module(readFileSync(join(program.dir, program.file)))
    const instance = new jspiWebAssembly.Instance(module, { wasi_snapshot_preview1: suspendingImports(host, jspiWebAssembly) } as WebAssembly.Imports)
    return { code: await runEntry(instance, host, '_start', jspiWebAssembly), stdout }
  } finally {
    await disk.cleanup()
  }
}

describe.skipIf(SUITE === undefined || !hasJspi)('wasi-testsuite, wasm32-wasip1', () => {
  for (const program of SUITE === undefined ? [] : programs(SUITE)) {
    const test = KNOWN_FAILURES[program.name] === undefined ? it : it.fails
    test(program.name, async () => {
      const { code, stdout } = await run(program)
      expect(code).toBe(program.spec.exit_code ?? 0)
      if (program.spec.stdout !== undefined) expect(stdout).toBe(program.spec.stdout)
    })
  }
})
