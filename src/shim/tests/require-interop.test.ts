// Proves A287's fix against a REAL bundler, not just a direct import: esbuild
// hands a bundled CommonJS `require()` the module's ESM namespace, never the
// default export, so this bundles a tiny CJS consumer through the exact
// alias plugin electron.vite.config.ts and the e2e fixtures use
// (shim-esbuild-plugin.ts) and evaluates the result, rather than asserting
// against the shim's own exports directly.

import esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { shimEsbuildPlugin } from './support/shim-esbuild-plugin.js'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

interface CapturedRefusal { name: unknown, api: unknown, message: unknown }

/** Bundles `source` (a CJS `require()` consumer) as esbuild's own e2e fixtures are bundled, then runs the IIFE result and returns what it captured onto `globalThis.__A287_RESULT`. */
async function runBundledConsumer (source: string): Promise<CapturedRefusal> {
  const built = await esbuild.build({
    stdin: { contents: source, resolveDir: REPO_ROOT, sourcefile: 'a287-consumer.cjs', loader: 'js' },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    plugins: [shimEsbuildPlugin()],
    logLevel: 'silent'
  })
  const [output] = built.outputFiles
  if (output === undefined) throw new Error('esbuild produced no output for the A287 consumer')
  const globalRecord = globalThis as unknown as { __A287_RESULT?: CapturedRefusal }
  delete globalRecord.__A287_RESULT
  // eslint-disable-next-line no-new-func -- runs esbuild's own IIFE output, the same way a <script> tag would.
  new Function(output.text)()
  const result = globalRecord.__A287_RESULT
  if (result === undefined) throw new Error('the bundled consumer never set __A287_RESULT -- did it throw before its own try/catch?')
  return result
}

function consumer (specifier: string, call: string): string {
  return `
    const mod = require('${specifier}');
    try { ${call}; globalThis.__A287_RESULT = { name: 'no-throw', api: undefined, message: undefined } }
    catch (error) { globalThis.__A287_RESULT = { name: error.name, api: error.api, message: error.message } }
  `
}

describe('a bundled CommonJS require() names the gap (A287)', () => {
  it('os (nodeModule-generic bucket): require(\'os\').userInfo() refuses by name', async () => {
    const result = await runBundledConsumer(consumer('os', 'mod.userInfo()'))
    expect(result).toMatchObject({ name: 'OrivonShimError', api: 'os.userInfo' })
  })

  it('net (custom-classify bucket): require(\'net\').getDefaultAutoSelectFamily() refuses by name', async () => {
    const result = await runBundledConsumer(consumer('net', 'mod.getDefaultAutoSelectFamily()'))
    expect(result).toMatchObject({ name: 'OrivonShimError', api: 'net.getDefaultAutoSelectFamily' })
  })

  it('a built member is unaffected: require(\'os\').hostname() still runs', async () => {
    const result = await runBundledConsumer(consumer('os', 'mod.hostname()'))
    expect(result.name).toBe('no-throw')
  })

  it('a member real only on the shim\'s default export still resolves through the namespace: require(\'util\').isArray works', async () => {
    const result = await runBundledConsumer(`
      const mod = require('util');
      try { globalThis.__A287_RESULT = { name: typeof mod.isArray, api: mod.isArray([1, 2, 3]), message: undefined } }
      catch (error) { globalThis.__A287_RESULT = { name: error.name, api: error.api, message: error.message } }
    `)
    expect(result).toMatchObject({ name: 'function', api: true })
  })
})
