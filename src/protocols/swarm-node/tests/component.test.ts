import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { componentImports } from '../../../shim/wasi-p2/imports.js'
import { InputStream, OutputStream } from '../../../shim/wasi-p2/io.js'
import { instantiateFrom, tourFixture } from '../../../shim/wasi-p2/tests/support/component-fixture.js'
import { hasJspi, jspiWebAssembly } from '../../../shim/wasi/tests/support/jspi.js'
import { coreModuleReader, loadComponent } from '../component.js'
import { createConfinedFs } from '../node-fs.js'

let directory: string

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'swarm-node-component-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

async function install (name: string, glue = tourFixture().glue): Promise<void> {
  await writeFile(join(directory, `${name}.js`), glue)
  for (const [file, bytes] of tourFixture().cores) await writeFile(join(directory, file), bytes)
}

const NO_IMPORTS = {}

describe('coreModuleReader', () => {
  it.each(['../x.wasm', 'dir/x.wasm', '/etc/x.wasm', 'x.js', 'x.wasm\0', '', '..'])('refuses the core module name %j', async (file) => {
    await expect(coreModuleReader(directory, { ms: 0 })(file)).rejects.toThrow(/core module/)
  })

  it.skipIf(!hasJspi)('compiles a core module of the directory and counts the time', async () => {
    await install('tour')
    const compiled = { ms: 0 }
    const module = await coreModuleReader(directory, compiled, jspiWebAssembly)('tour.core2.wasm')
    expect(module).toBeInstanceOf(jspiWebAssembly.Module)
    expect(compiled.ms).toBeGreaterThan(0)
  })
})

describe('loadComponent', () => {
  it('refuses a file that is not jco output, such as a fallback page', async () => {
    await writeFile(join(directory, 'swarm-node.js'), '<!doctype html><title>404</title>')
    await expect(loadComponent(directory, 'swarm-node', NO_IMPORTS)).rejects.toThrow(/not jco's output/)
  })

  it('refuses output transpiled without the host\'s asynchronous imports, naming the command', async () => {
    await install('swarm-node', tourFixture().glue.replace(/([\w$]+)\.manuallyAsync\s*=\s*!0/g, 'void 0'))
    await expect(loadComponent(directory, 'swarm-node', NO_IMPORTS)).rejects.toThrow(/jco transpile swarm-node\.wasm --name swarm-node/)
  })

  it('fails when the directory has no component', async () => {
    await expect(loadComponent(directory, 'swarm-node', NO_IMPORTS)).rejects.toThrow(/ENOENT/)
  })

  it.skipIf(!hasJspi)('runs a component from the directory against the confined fs, and reports its exit code', async () => {
    await install('swarm-node')
    const data = join(directory, 'data')
    const stdinChunks = [new TextEncoder().encode('ping\n')]
    let stdout = ''
    const imports = componentImports({
      fs: await createConfinedFs(data),
      net: {} as never,
      preopens: { '/': '/orivon/app' },
      args: ['tour'],
      env: {},
      stdin: new InputStream(async () => stdinChunks.shift() ?? new Uint8Array(0)),
      stdout: new OutputStream(async (bytes) => { stdout += new TextDecoder().decode(bytes) }),
      stderr: new OutputStream(async () => {})
    })
    const loaded = await loadComponent(directory, 'swarm-node', imports, { instantiate: async (glue) => instantiateFrom(glue, jspiWebAssembly), wasm: jspiWebAssembly })
    expect(await loaded.run()).toBe(1)
    expect(stdout).toBe('ping\n')
    expect(loaded.compileMs).toBeGreaterThan(0)
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(data, 'from-component.txt'), 'utf8')).toBe('written by a component\n')
  })
})
