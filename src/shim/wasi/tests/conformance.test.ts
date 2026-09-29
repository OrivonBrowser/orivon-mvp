// The preview1 conformance suite (WebAssembly/wasi-testsuite): real C,
// Rust and AssemblyScript programs, each with its expected exit code and
// output, run against the host over a real temporary directory, once through
// JSPI and once through the synchronous imports a native addon gets. Opt-in: the
// suite's binaries are not in this repository, so this skips unless
// ORIVON_WASI_TESTSUITE names a checkout of its prebuilt branch:
//
//   git clone --depth 1 -b prod/testsuite-base https://github.com/WebAssembly/wasi-testsuite <dir>
//   ORIVON_WASI_TESTSUITE=<dir> npx vitest run src/shim/wasi/tests/conformance.test.ts
//
// Last run against 609c446139956ff30239f87cb18af1dc6128bed2: 63 of 72 pass, in each mode.

import { readFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRealDiskFs } from '../../tests/support/real-disk-fs.js'
import { createWasiHost } from '../host.js'
import { bindInstanceMemory, runCommand, suspendingImports } from '../instantiate.js'
import { WasiExit } from '../termination.js'
import { hasJspi, jspiWebAssembly } from './support/jspi.js'
import { KNOWN_FAILURES, type Program, programs } from './support/testsuite.js'

const SUITE = process.env.ORIVON_WASI_TESTSUITE
/** `_start` called directly on the synchronous imports, as an addon's exports are. */
function runSynchronously (instance: WebAssembly.Instance, host: ReturnType<typeof createWasiHost>): number {
  bindInstanceMemory(instance, host)
  try {
    (instance.exports._start as () => void)()
    return 0
  } catch (error) {
    if (error instanceof WasiExit) return error.code
    throw error
  }
}

async function run (program: Program, mode: 'jspi' | 'sync'): Promise<{ code: number, stdout: string }> {
  const disk = await createRealDiskFs()
  try {
    if (program.spec.root !== undefined) await cp(join(program.dir, program.spec.root), disk.root, { recursive: true })
    let stdout = ''
    const collect = (bytes: Uint8Array): void => { stdout += new TextDecoder().decode(bytes) }
    const host = createWasiHost({
      fs: disk.orivon.fs,
      syncFs: disk.syncFs,
      args: [program.file, ...(program.spec.args ?? [])],
      env: program.spec.env ?? {},
      preopens: program.spec.root === undefined ? {} : { '/': '/orivon/app' },
      stdout: collect,
      stderr: () => {},
      syncStdout: collect,
      syncStderr: () => {}
    })
    const bytes = readFileSync(join(program.dir, program.file))
    if (mode === 'sync') {
      try {
        const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { wasi_snapshot_preview1: host.syncFunctions } as WebAssembly.Imports)
        return { code: runSynchronously(instance, host), stdout }
      } finally {
        await host.finish()
      }
    }
    const module = new jspiWebAssembly.Module(bytes)
    const instance = new jspiWebAssembly.Instance(module, { wasi_snapshot_preview1: suspendingImports(host, jspiWebAssembly) } as WebAssembly.Imports)
    return { code: await runCommand(instance, host, jspiWebAssembly), stdout }
  } finally {
    await disk.cleanup()
  }
}

for (const mode of ['jspi', 'sync'] as const) {
  describe.skipIf(SUITE === undefined || (mode === 'jspi' && !hasJspi))(`wasi-testsuite, wasm32-wasip1, ${mode}`, () => {
    for (const program of SUITE === undefined ? [] : programs(SUITE)) {
      const test = KNOWN_FAILURES[program.name] === undefined ? it : it.fails
      test(program.name, async () => {
        const { code, stdout } = await run(program, mode)
        expect(code).toBe(program.spec.exit_code ?? 0)
        if (program.spec.stdout !== undefined) expect(stdout).toBe(program.spec.stdout)
      })
    }
  })
}
