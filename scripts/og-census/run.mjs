// Runs the census tool from source: bundles `main.ts` with esbuild (the build's own bundler) into `.cache/og-census/`, so the TypeScript
// the resolver is written in runs as it is, then calls it with this command's arguments. Needs only `npm install`; nothing is installed.
//
//   node scripts/og-census/run.mjs [--block N] [--out PATH] [--check] [--validate]
import { buildSync } from 'esbuild'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const bundle = join(here, '..', '..', '.cache', 'og-census', 'main.mjs')

buildSync({ entryPoints: [join(here, 'main.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', logLevel: 'error' })
const { main } = await import(pathToFileURL(bundle).href)
main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code },
  (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
)
