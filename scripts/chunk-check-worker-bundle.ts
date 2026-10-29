// The code of the verifier host's chunk check thread as one CommonJS script with nothing to load beside it, so a thread can be
// started from the string (`new Worker(code, { eval: true })`) wherever the host's own files are: in a source tree, or in an
// app.asar that a thread cannot read from. electron.vite.config.ts inlines it into the host's entry; a unit test builds it the same way.
import { resolve } from 'node:path'
import { build } from 'vite'

const WORKER_SOURCE = 'src/protocols/verifier-host/chunk-check-worker.ts'

export async function chunkCheckWorkerCode (root: string): Promise<string> {
  const result = await build({
    configFile: false,
    root,
    logLevel: 'warn',
    ssr: { target: 'node', noExternal: true },
    build: {
      ssr: resolve(root, WORKER_SOURCE),
      write: false,
      minify: false,
      target: 'node22',
      rollupOptions: { output: { format: 'cjs', inlineDynamicImports: true } }
    }
  })
  const chunks = [result].flat().flatMap((out) => 'output' in out ? out.output : []).filter((output) => output.type === 'chunk')
  const [chunk] = chunks
  if (chunks.length !== 1 || chunk === undefined) throw new Error(`bundling the chunk check thread produced ${String(chunks.length)} chunks, not one`)
  return chunk.code
}
