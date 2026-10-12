import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { componentImports } from '../../../shim/wasi-p2/imports.js'
import { InputStream, OutputStream } from '../../../shim/wasi-p2/io.js'
import { instantiateFrom, tourFixture } from '../../../shim/wasi-p2/tests/support/component-fixture.js'
import { hasJspi, jspiWebAssembly } from '../../../shim/wasi/tests/support/jspi.js'
import { PinMismatch, coreModuleReader, loadComponent, readPinned } from '../component.js'
import { createConfinedFs } from '../node-fs.js'
import type { PinnedFile } from '../protocol.js'

let directory: string

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'swarm-node-component-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Writes the fixture as `<name>` files and returns the pins a build would hold for them. */
async function install (name: string, glue = tourFixture().glue): Promise<PinnedFile[]> {
  const pins: PinnedFile[] = []
  const glueBytes = Buffer.from(glue)
  await writeFile(join(directory, `${name}.js`), glueBytes)
  pins.push({ name: `${name}.js`, bytes: glueBytes.length, sha256: sha(glueBytes) })
  for (const [file, bytes] of tourFixture().cores) {
    await writeFile(join(directory, file), bytes)
    pins.push({ name: file, bytes: bytes.length, sha256: sha(bytes) })
  }
  return pins
}

const NO_IMPORTS = {}

describe('readPinned', () => {
  it('returns the bytes of a pinned file, hashed as read', async () => {
    const pins = await install('tour')
    const glue = await readPinned(directory, pins, 'tour.js')
    expect(glue.toString()).toBe(tourFixture().glue)
  })

  it.each(['../x.wasm', 'dir/x.wasm', '/etc/x.wasm', 'x.wasm\0', '', '..', 'unpinned.wasm'])('refuses the name %j, which this build does not pin', async (file) => {
    const pins = await install('tour')
    await expect(readPinned(directory, pins, file)).rejects.toBeInstanceOf(PinMismatch)
  })

  it('refuses a file whose bytes are not the pinned ones, whatever their size', async () => {
    const pins = await install('tour')
    const glue = Buffer.from(tourFixture().glue)
    await writeFile(join(directory, 'tour.js'), Buffer.concat([glue.subarray(0, glue.length - 1), Buffer.from('!')]))
    await expect(readPinned(directory, pins, 'tour.js')).rejects.toThrow(/tour\.js is not the file this build pins/)
    await writeFile(join(directory, 'tour.js'), Buffer.concat([glue, Buffer.from(' ')]))
    await expect(readPinned(directory, pins, 'tour.js')).rejects.toBeInstanceOf(PinMismatch)
  })
})

describe('coreModuleReader', () => {
  it('refuses a name that is not a core module, even a pinned one', async () => {
    const pins = await install('tour')
    await expect(coreModuleReader(directory, pins, { ms: 0 })('tour.js')).rejects.toThrow(/core module/)
  })

  it('refuses a core module of the directory that is not pinned', async () => {
    const pins = (await install('tour')).filter((pin) => pin.name !== 'tour.core2.wasm')
    await expect(coreModuleReader(directory, pins, { ms: 0 })('tour.core2.wasm')).rejects.toBeInstanceOf(PinMismatch)
  })

  it.skipIf(!hasJspi)('compiles exactly the bytes it hashed, and counts the time', async () => {
    const pins = await install('tour')
    const compiled = { ms: 0 }
    const compile = vi.spyOn(jspiWebAssembly, 'compile')
    const module = await coreModuleReader(directory, pins, compiled, jspiWebAssembly)('tour.core2.wasm')
    expect(module).toBeInstanceOf(jspiWebAssembly.Module)
    expect(compile).toHaveBeenCalledTimes(1)
    expect(sha(compile.mock.calls[0]?.[0] as Uint8Array)).toBe(pins.find((pin) => pin.name === 'tour.core2.wasm')?.sha256)
    expect(compiled.ms).toBeGreaterThan(0)
    compile.mockRestore()
  })

  it.skipIf(!hasJspi)('compiles nothing from a core module that changed after it was pinned', async () => {
    const pins = await install('tour')
    const core = await readFile(join(directory, 'tour.core2.wasm'))
    await writeFile(join(directory, 'tour.core2.wasm'), Buffer.concat([core, Buffer.from([0])]))
    const compile = vi.spyOn(jspiWebAssembly, 'compile')
    await expect(coreModuleReader(directory, pins, { ms: 0 }, jspiWebAssembly)('tour.core2.wasm')).rejects.toBeInstanceOf(PinMismatch)
    expect(compile).not.toHaveBeenCalled()
    compile.mockRestore()
  })
})

describe('loadComponent', () => {
  it('refuses a file that is not jco output, such as a fallback page', async () => {
    const page = Buffer.from('<!doctype html><title>404</title>')
    await writeFile(join(directory, 'swarm-node.js'), page)
    const pins = [{ name: 'swarm-node.js', bytes: page.length, sha256: sha(page) }]
    await expect(loadComponent(directory, 'swarm-node', pins, NO_IMPORTS)).rejects.toThrow(/not jco's output/)
  })

  it('refuses output transpiled without the host\'s asynchronous imports, naming the command', async () => {
    const pins = await install('swarm-node', tourFixture().glue.replace(/([\w$]+)\.manuallyAsync\s*=\s*!0/g, 'void 0'))
    await expect(loadComponent(directory, 'swarm-node', pins, NO_IMPORTS)).rejects.toThrow(/jco transpile swarm-node\.wasm --name swarm-node/)
  })

  it('fails when the directory has no component', async () => {
    const pins: PinnedFile[] = [{ name: 'swarm-node.js', bytes: 1, sha256: 'a'.repeat(64) }]
    await expect(loadComponent(directory, 'swarm-node', pins, NO_IMPORTS)).rejects.toThrow(/ENOENT/)
  })

  it('does not import glue whose bytes are not the pinned ones', async () => {
    const pins = await install('swarm-node')
    await writeFile(join(directory, 'swarm-node.js'), `${tourFixture().glue}\n// changed after it was pinned`)
    const instantiate = vi.fn()
    await expect(loadComponent(directory, 'swarm-node', pins, NO_IMPORTS, { instantiate })).rejects.toBeInstanceOf(PinMismatch)
    expect(instantiate).not.toHaveBeenCalled()
  })

  it('does not import glue that is not pinned', async () => {
    const pins = (await install('swarm-node')).filter((pin) => pin.name !== 'swarm-node.js')
    await expect(loadComponent(directory, 'swarm-node', pins, NO_IMPORTS, { instantiate: vi.fn() })).rejects.toBeInstanceOf(PinMismatch)
  })

  it.skipIf(!hasJspi)('runs a component from the directory against the confined fs, and reports its exit code', async () => {
    const pins = await install('swarm-node')
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
    const loaded = await loadComponent(directory, 'swarm-node', pins, imports, { instantiate: async (glue) => instantiateFrom(glue, jspiWebAssembly), wasm: jspiWebAssembly })
    expect(await loaded.run()).toBe(1)
    expect(stdout).toBe('ping\n')
    expect(loaded.compileMs).toBeGreaterThan(0)
    expect(await readFile(join(data, 'from-component.txt'), 'utf8')).toBe('written by a component\n')
  })
})
