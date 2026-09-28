// A real WASI 0.2 component, transpiled by jco as a port is told to, run
// against the host: stdin through stdout, a file written through the
// preopen, stderr, and the exit code, with every suspending import
// reaching the page's asynchronous calls through JSPI.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRealDiskFs, type RealDiskFs } from '../../tests/support/real-disk-fs.js'
import { hasJspi, jspiWebAssembly } from '../../wasi/tests/support/jspi.js'
import { componentImports } from '../imports.js'
import { InputStream, OutputStream } from '../io.js'
import { runComponent, transpileCommand, unmarkedAsyncImports } from '../run.js'
import { createFakeTcpSocket } from '../../tests/support/fake-tcp-socket.js'
import { SOCKET_TARGET, coreModules, instantiateFrom, socketFixture, tourFixture } from './support/component-fixture.js'

let disk: RealDiskFs | undefined

afterEach(async () => {
  await disk?.cleanup()
  disk = undefined
})

describe('jco\'s output as a port ships it', () => {
  it('marks every import the host answers asynchronously, even minified', () => {
    expect(unmarkedAsyncImports(tourFixture().glue)).toEqual([])
  })

  it('is refused, naming each import, when transpiled without the host\'s list', () => {
    const unmarked = unmarkedAsyncImports(tourFixture().glue.replace(/([\w$]+)\.manuallyAsync\s*=\s*!0/g, 'void 0'))
    expect(unmarked).toContain('wasi:io/streams#blockingWriteAndFlush')
    expect(unmarked).toContain('wasi:filesystem/types#openAt')
    expect(transpileCommand('/bin/tool.wasm')).toMatch(/^jco transpile \/bin\/tool\.wasm --name tool -o tool\.p2 .*--async-imports 'wasi:io\/poll#poll'/)
  })
})

describe('instantiation', () => {
  it('refuses output whose wasi:cli/run was not transpiled as asynchronous, naming the flag', async () => {
    const instantiate = async (): Promise<Record<string, unknown>> => ({ run: { run: () => undefined } })
    await expect(runComponent(instantiate, async () => { throw new Error('unused') }, {})).rejects.toThrow(/--async-exports wasi:cli\/run#run/)
  })
})

describe.skipIf(!hasJspi)('a command component', () => {
  it('echoes stdin, writes a file through orivon.fs, and exits 1 for its non-zero code', async () => {
    disk = await createRealDiskFs()
    const fixture = tourFixture()
    const stdinChunks = [new TextEncoder().encode('ping\n')]
    let stdout = ''
    let stderr = ''
    const imports = componentImports({
      fs: disk.orivon.fs,
      net: {} as never,
      preopens: { '/': '/orivon/app' },
      args: ['tour'],
      env: {},
      stdin: new InputStream(async () => stdinChunks.shift() ?? new Uint8Array(0)),
      stdout: new OutputStream(async (bytes) => { stdout += new TextDecoder().decode(bytes) }),
      stderr: new OutputStream(async (bytes) => { stderr += new TextDecoder().decode(bytes) })
    })
    const code = await runComponent(instantiateFrom(fixture.glue, jspiWebAssembly), coreModules(fixture, jspiWebAssembly), imports)
    expect(stdout).toBe('ping\n')
    expect(stderr).toBe('done\n')
    expect(readFileSync(join(disk.root, 'from-component.txt'), 'utf8')).toBe('written by a component\n')
    expect(code).toBe(1)
  })
})

describe.skipIf(!hasJspi)('a component that opens a socket', () => {
  function run (connect: (target: { host: string, port: number }) => Promise<unknown>): { code: Promise<number>, stdout: () => string } {
    const fixture = socketFixture()
    let stdout = ''
    const imports = componentImports({
      fs: {} as never,
      net: { connect, listen: vi.fn(), udpBind: vi.fn(), lookup: vi.fn() } as never,
      preopens: {},
      args: ['socket'],
      env: {},
      stdin: new InputStream(async () => new Uint8Array(0)),
      stdout: new OutputStream(async (bytes) => { stdout += new TextDecoder().decode(bytes) }),
      stderr: new OutputStream(async () => {})
    })
    return { code: runComponent(instantiateFrom(fixture.glue, jspiWebAssembly), coreModules(fixture, jspiWebAssembly), imports), stdout: () => stdout }
  }

  it('connects through orivon.net, sends, and prints the reply, every call lowered by jco\'s glue', async () => {
    const fake = createFakeTcpSocket({ remoteAddress: '127.0.0.1', remotePort: SOCKET_TARGET.port })
    const connect = vi.fn(async () => {
      // An echo server: what the component writes comes back.
      const echo = setInterval(() => { const sent = fake.written.shift(); if (sent !== undefined) fake.push(sent) }, 1)
      setTimeout(() => { clearInterval(echo) }, 2_000)
      return fake.socket
    })
    const { code, stdout } = run(connect)
    expect(await code).toBe(0)
    expect(connect).toHaveBeenCalledWith({ host: '127.0.0.1', port: SOCKET_TARGET.port })
    expect(stdout()).toBe(SOCKET_TARGET.message)
  })

  it('ends with 1 when orivon.net refuses the connection', async () => {
    const { code, stdout } = run(async () => { throw Object.assign(new Error('outside the grant'), { name: 'OrivonError', code: 'denied' }) })
    expect(await code).toBe(1)
    expect(stdout()).toBe('')
  })
})
