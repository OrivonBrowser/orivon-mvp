// The preview1 conformance suite run through the WASI 0.2 host: each program
// made a component with the preview1 adapter and transpiled as a port is
// told to, so every file, stdio and clock call reaches this host's
// interfaces. WASI 0.2's exit carries only success or failure, so a program
// expecting a non-zero code is expected to end with 1. Opt-in: it needs
// both the suite (../../wasi/tests/conformance.test.ts) and jco (support/jco.ts):
//
//   ORIVON_WASI_TESTSUITE=<suite> ORIVON_JCO_DIR=<jco> npx vitest run src/shim/wasi-p2/tests/conformance.test.ts

import { readFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createRealDiskFs } from '../../tests/support/real-disk-fs.js'
import { hasJspi, jspiWebAssembly } from '../../wasi/tests/support/jspi.js'
import { KNOWN_FAILURES, type Program, programs } from '../../wasi/tests/support/testsuite.js'
import { componentImports } from '../imports.js'
import { InputStream, OutputStream } from '../io.js'
import { runComponent } from '../run.js'
import { instantiateFrom } from './support/component-fixture.js'
import { JCO_DIR, type Jco, loadJco } from './support/jco.js'

const SUITE = process.env.ORIVON_WASI_TESTSUITE

/**
 * Programs the preview1 adapter itself breaks: they export no cabi_realloc,
 * so the adapter takes a page for its state with memory.grow, and
 * AssemblyScript's allocator grows into that page (the adapter reports its
 * state's magic overwritten). A wasm32-wasip2 build has no adapter.
 */
const ADAPTER_FAILURES: Readonly<Record<string, string>> = {
  'assemblyscript/args_get-multiple-arguments': 'allocator overlaps the adapter state',
  'assemblyscript/environ_get-multiple-variables': 'allocator overlaps the adapter state',
  'assemblyscript/fd_write-to-invalid-fd': 'allocator overlaps the adapter state'
}

let jco: Jco

async function run (program: Program): Promise<{ code: number, stdout: string }> {
  const disk = await createRealDiskFs()
  try {
    if (program.spec.root !== undefined) await cp(join(program.dir, program.spec.root), disk.root, { recursive: true })
    const { glue, cores } = await jco.adaptAndTranspile(readFileSync(join(program.dir, program.file)), 'program')
    let stdout = ''
    const imports = componentImports({
      fs: disk.orivon.fs,
      net: {} as never,
      preopens: program.spec.root === undefined ? {} : { '/': '/orivon/app' },
      args: [program.file, ...(program.spec.args ?? [])],
      env: program.spec.env ?? {},
      stdin: new InputStream(async () => new Uint8Array(0)),
      stdout: new OutputStream(async (bytes) => { stdout += new TextDecoder().decode(bytes) }),
      stderr: new OutputStream(async () => {})
    })
    const getCoreModule = async (name: string): Promise<WebAssembly.Module> => await jspiWebAssembly.compile(cores.get(name) as Uint8Array<ArrayBuffer>)
    return { code: await runComponent(instantiateFrom(glue, jspiWebAssembly), getCoreModule, imports), stdout }
  } finally {
    await disk.cleanup()
  }
}

describe.skipIf(SUITE === undefined || JCO_DIR === undefined || !hasJspi)('wasi-testsuite, wasm32-wasip1, through the WASI 0.2 host', () => {
  beforeAll(async () => { jco = await loadJco() })

  for (const program of SUITE === undefined ? [] : programs(SUITE)) {
    const test = KNOWN_FAILURES[program.name] === undefined && ADAPTER_FAILURES[program.name] === undefined ? it : it.fails
    test(program.name, async () => {
      const { code, stdout } = await run(program)
      expect(code).toBe((program.spec.exit_code ?? 0) === 0 ? 0 : 1)
      if (program.spec.stdout !== undefined) expect(stdout).toBe(program.spec.stdout)
    })
  }
})
