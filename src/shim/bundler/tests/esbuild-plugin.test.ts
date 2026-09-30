import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAliasEntries } from '../../module-map.js'
import { VIRTUAL_ROOT } from '../../virtual-root.js'
import { orivonShimPlugin, shimAssets, virtualRoot } from '../esbuild-plugin.js'

const PLUGIN_PATH = fileURLToPath(new URL('../esbuild-plugin.ts', import.meta.url))
let dir = ''

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'orivon-plugin-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

async function bundle (source: string, platform: 'node' | 'browser' = 'node'): Promise<{ text: string, inputs: string[] }> {
  const entry = join(dir, `entry-${Math.random().toString(36).slice(2)}.js`)
  writeFileSync(entry, source)
  const built = await esbuild.build({
    entryPoints: [entry], bundle: true, platform, format: 'esm', write: false, metafile: true, logLevel: 'silent',
    plugins: [orivonShimPlugin()], nodePaths: [fileURLToPath(new URL('../../../../node_modules', import.meta.url))]
  })
  return { text: built.outputFiles[0]?.text ?? '', inputs: Object.keys(built.metafile.inputs) }
}

describe('orivonShimPlugin', () => {
  it('exports the virtual root', () => {
    expect(virtualRoot).toBe(VIRTUAL_ROOT)
  })

  it('resolves every ready row, bare and node:-prefixed, into this checkout', async () => {
    const entries = buildAliasEntries()
    const source = entries.flatMap((entry, i) => [...(entry.prefixOnly === true ? [] : [`import * as a${i} from '${entry.specifier}'`]), `import * as b${i} from 'node:${entry.specifier}'`, `globalThis.x${i} = [${entry.prefixOnly === true ? '' : `a${i}, `}b${i}]`]).join('\n')
    const { inputs } = await bundle(source)
    const shim = fileURLToPath(new URL('../../', import.meta.url))
    for (const entry of entries.filter((e) => e.kind === 'local')) {
      const file = join(shim, entry.implementation.replace(/\.js$/, '.ts'))
      expect(inputs.some((input) => file.endsWith(join(input))), entry.specifier).toBe(true)
    }
    for (const entry of entries.filter((e) => e.kind === 'package')) {
      expect(inputs.some((input) => input.includes(`node_modules/${entry.implementation}/`)), entry.specifier).toBe(true)
    }
  }, 60_000)

  it('resolves a package row named like a builtin (events) to the npm package under platform node', async () => {
    const { inputs } = await bundle("import E from 'events'\nglobalThis.E = E")
    expect(inputs.some((input) => input.includes('node_modules/events/'))).toBe(true)
  })

  it('hands a bundled CommonJS require() of a module that is itself a function (assert) that function, not the namespace', async () => {
    const { text } = await bundle("const assert = require('assert')\nconsole.log(JSON.stringify([typeof assert, typeof assert.strictEqual, typeof assert.AssertionError]))\nassert(true, 'fine')")
    const file = join(dir, 'require-assert.mjs')
    writeFileSync(file, text)
    const result = spawnNode(file)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual(['function', 'function', 'function'])
  })

  it('hands a bundled CommonJS require() of a module object the default export itself, so require(process) is the global and writes to it stick', async () => {
    const { text } = await bundle("const p = require('process')\nconst os = require('os')\np.exitCode = 2\nconsole.log(JSON.stringify([p === process, globalThis.process.exitCode, require('process') === p, typeof os.hostname]))")
    const file = join(dir, 'require-process.mjs')
    writeFileSync(file, text)
    const result = spawnNode(file)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual([true, 2, true, 'function'])
  })

  it('does not capture a subpath', async () => {
    writeFileSync(join(dir, 'sub.js'), 'export default 1')
    const { text } = await bundle(`import x from './sub.js'\nglobalThis.x = x`)
    expect(text).toContain('1')
  })

  it('fails on an unmapped builtin, naming the specifier and the importer', async () => {
    const entry = join(dir, 'unmapped.js')
    writeFileSync(entry, "import 'cluster'\nimport 'node:sea'\n")
    const error = await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', write: false, logLevel: 'silent', plugins: [orivonShimPlugin()] }).then(() => undefined, (e: esbuild.BuildFailure) => e)
    const texts = error?.errors.map((e) => e.text) ?? []
    expect(texts.some((t) => t.includes("'cluster'") && t.includes(entry))).toBe(true)
    expect(texts.some((t) => t.includes("'node:sea'"))).toBe(true)
  })

  it('registers no onLoad, so a port can add its own', async () => {
    const seen: string[] = []
    await esbuild.build({
      entryPoints: [join(dir, 'sub.js')], bundle: true, write: false, logLevel: 'silent',
      plugins: [orivonShimPlugin(), { name: 'mine', setup (b) { b.onLoad({ filter: /sub\.js$/ }, () => { seen.push('loaded'); return { contents: 'export default 2', loader: 'js' } }) } }]
    })
    expect(seen).toEqual(['loaded'])
  })

  it('applies a shim dependency\'s browser field under platform node, so crypto works', async () => {
    const entry = join(dir, 'crypto-entry.js')
    writeFileSync(entry, "import crypto from 'crypto'\nimport os from 'os'\nconsole.log(JSON.stringify([crypto.createHash('sha1').update('abc').digest('hex'), crypto.createHmac('sha256', 'k').update('x').digest('hex').length, crypto.randomBytes(8).length]))\n")
    const built = await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent', plugins: [orivonShimPlugin()] })
    const bundle = join(dir, 'crypto-bundle.mjs')
    writeFileSync(bundle, built.outputFiles[0]?.text ?? '')
    const child = spawnNode(bundle)
    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual(['a9993e364706816aba3e25717850c26c9cd0d89d', 64, 8])
  }, 60_000)

  it('leaves a devDependency of this checkout on Node semantics', async () => {
    const { inputs } = await bundle("import iconv from 'iconv-lite'\nglobalThis.x = iconv")
    expect(inputs.some((input) => input.endsWith('iconv-lite/lib/extend-node.js'))).toBe(true)
  })

  it('words an unmapped builtin exactly as a port parses it', async () => {
    const entry = join(dir, 'exact-wording.js')
    writeFileSync(entry, "import 'cluster'\n")
    const error = await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', write: false, logLevel: 'silent', plugins: [orivonShimPlugin()] }).then(() => undefined, (e: esbuild.BuildFailure) => e)
    expect(error?.errors[0]?.text).toBe(`'cluster' is a Node builtin the Orivon shim has no module for (imported from ${entry}); see src/shim/module-map.ts`)
  })

  it('maps node:sqlite and never the bare npm package of that name', async () => {
    const { inputs } = await bundle("import 'node:sqlite'\nimport 'orivon-node-shim/sqlite-ready'")
    expect(inputs.some((input) => input.endsWith('src/shim/sqlite/index.ts'))).toBe(true)
    expect(inputs.some((input) => input.endsWith('src/shim/sqlite/ready.ts'))).toBe(true)
    const entry = join(dir, 'bare-sqlite.js')
    writeFileSync(entry, "import 'sqlite'\n")
    const error = await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', write: false, logLevel: 'silent', plugins: [orivonShimPlugin()] }).then(() => undefined, (e: esbuild.BuildFailure) => e)
    expect(error?.errors[0]?.text).toContain('Could not resolve "sqlite"')
  })

  it('bundles the SQLite engine\'s browser build under platform node, and lists the wasm it fetches', async () => {
    const { inputs } = await bundle("import 'orivon-node-shim/sqlite-ready'")
    expect(inputs.some((input) => input.endsWith('@sqlite.org/sqlite-wasm/dist/index.mjs'))).toBe(true)
    expect(inputs.some((input) => input.endsWith('sqlite-wasm/dist/node.mjs'))).toBe(false)
    const assets = shimAssets()
    expect(assets.map((asset) => asset.name)).toEqual(['sqlite3.wasm'])
    expect(existsSync(assets[0]?.path ?? '')).toBe(true)
  })

  it('loads under plain node from another directory', () => {
    mkdirSync(join(dir, 'outside'), { recursive: true })
    const entry = join(dir, 'outside', 'app.js')
    const runner = join(dir, 'outside', 'run.mjs')
    writeFileSync(entry, "import fs from 'node:fs'\nimport net from 'net'\nglobalThis.probe = [fs, net]\n")
    writeFileSync(runner, `
      import { build } from ${JSON.stringify(esbuildMain())}
      import { orivonShimPlugin, virtualRoot } from ${JSON.stringify(PLUGIN_PATH)}
      const built = await build({ entryPoints: [${JSON.stringify(entry)}], bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, logLevel: 'silent', plugins: [orivonShimPlugin()] })
      console.log(JSON.stringify({ virtualRoot, inputs: Object.keys(built.metafile.inputs).filter((i) => i.includes('src/shim/')) }))
    `)
    const child = spawnNode(runner)
    expect(child.status, child.stderr).toBe(0)
    const out = JSON.parse(child.stdout) as { virtualRoot: string, inputs: string[] }
    expect(out.virtualRoot).toBe(VIRTUAL_ROOT)
    expect(out.inputs.some((i) => i.endsWith('fs/fs.ts'))).toBe(true)
    expect(out.inputs.some((i) => i.endsWith('net/net.ts'))).toBe(true)
  }, 60_000)
})

function esbuildMain (): string {
  return fileURLToPath(import.meta.resolve('esbuild'))
}

function spawnNode (script: string): { status: number | null, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script], { encoding: 'utf8', cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}
