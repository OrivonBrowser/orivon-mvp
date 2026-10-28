// runtime.generated.json is the Worker runtime, bundled. This builds it from
// runtime.ts and fails when the checked-in copy is stale; run with
// ORIVON_WRITE_WORKER_RUNTIME=1 to rewrite it after changing anything the
// runtime imports.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'
import { expect, it } from 'vitest'
import { shimEsbuildPlugin } from '../../tests/support/shim-esbuild-plugin.js'

const ENTRY = fileURLToPath(new URL('../runtime.ts', import.meta.url))
const GENERATED = fileURLToPath(new URL('../runtime.generated.json', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

async function bundle (): Promise<string> {
  const built = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    write: false,
    absWorkingDir: REPO_ROOT,
    plugins: [shimEsbuildPlugin()],
    logLevel: 'silent',
    metafile: true
  })
  // A package read from another checkout is bundled beside this one's copy, so the bundle differs from CI's.
  const outside = Object.keys(built.metafile.inputs).filter((input) => input.startsWith('../'))
  if (outside.length > 0) {
    throw new Error(`the bundle read ${String(outside.length)} files outside this checkout, ${outside[0]!} first: its node_modules reaches another checkout's (a symlink, or a node_modules/node_modules link inside a copy); see docs/development/parallel-work.md`)
  }
  const [output] = built.outputFiles
  if (output === undefined) throw new Error('esbuild produced no output for the Worker runtime')
  return output.text
}

it('runtime.generated.json is the current bundle of runtime.ts', async () => {
  const fresh = `${JSON.stringify({ source: await bundle() })}\n`
  if (process.env.ORIVON_WRITE_WORKER_RUNTIME === '1') writeFileSync(GENERATED, fresh)
  expect(readFileSync(GENERATED, 'utf8'), 'stale: rerun with ORIVON_WRITE_WORKER_RUNTIME=1').toBe(fresh)
}, 30_000)
