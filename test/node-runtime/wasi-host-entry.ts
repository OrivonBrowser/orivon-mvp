// Bundled with esbuild (platform: 'browser') by ./e2e-wasi-host.test.ts into
// the fixture app's own served script. It runs the pinned program.wasm the
// way ported Node code would: `new WASI(...)` from the `wasi` module target,
// the module fetched and compiled under the app's served CSP, and every file
// call reaching the real window.orivon.fs through JSPI.

import { WASI } from '../../src/shim/wasi/node-wasi.js'

export interface WasiRunResult {
  readonly exitCode?: number
  readonly stdout: string[]
  readonly error?: string
}

async function run (): Promise<WasiRunResult> {
  const stdout: string[] = []
  const log = console.log
  console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(' ')) }
  try {
    const wasi = new WASI({ version: 'preview1', args: ['program.wasm'], preopens: { '/': '/orivon/app' } })
    const { instance } = await WebAssembly.instantiateStreaming(fetch('/program.wasm'), wasi.getImportObject() as WebAssembly.Imports)
    return { exitCode: await wasi.start(instance), stdout }
  } catch (error) {
    return { stdout, error: String((error as Error)?.stack ?? error) }
  } finally {
    console.log = log
  }
}

;(globalThis as unknown as { wasiE2e: { run: typeof run } }).wasiE2e = { run }
