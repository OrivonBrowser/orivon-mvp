// child_process end to end in Node: the real module, the real Worker runtime
// run in-process (support/in-process-worker.ts), programs served by a fetch
// stub, and a real directory standing in for the broker.

import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../../contracts/capability-api.js'
import { OrivonShimError } from '../../errors.js'
import { createRealDiskFs, type RealDiskFs } from '../../tests/support/real-disk-fs.js'
import { hasJspi } from '../../wasi/tests/support/jspi.js'
import { echoProgram, failingProgram } from '../../wasi/tests/support/programs.js'
import { tourFixture } from '../../wasi-p2/tests/support/component-fixture.js'
import childProcess, { type ChildProcess, exec, execFile, execFileSync, fork, spawn } from '../index.js'
import { failNext, forkModules, workers } from './support/in-process-worker.js'

vi.mock('../../worker/launch.js', async () => ({ createChildWorker: (await import('./support/in-process-worker.js')).createInProcessWorker }))

const ORIGIN = 'https://app.test'
const COMPONENT_HEADER = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00])
const tour = tourFixture()
/** The fixture component's jco output under `<dir>.p2/`, as a port ships it. */
function componentOutput (dir: string, glue: string = tour.glue): Record<string, Uint8Array<ArrayBuffer> | string> {
  return { [`${dir}.p2/${dir.slice(dir.lastIndexOf('/') + 1)}.js`]: glue, ...Object.fromEntries([...tour.cores].map(([name, bytes]) => [`${dir}.p2/${name}`, bytes as Uint8Array<ArrayBuffer>])) }
}
const PROGRAMS: Record<string, Uint8Array<ArrayBuffer> | string> = {
  '/bin/tour.wasm': COMPONENT_HEADER,
  ...componentOutput('/bin/tour'),
  ...componentOutput('/bin/only'),
  '/bin/raw.wasm': COMPONENT_HEADER,
  '/bin/unmarked.wasm': COMPONENT_HEADER,
  ...componentOutput('/bin/unmarked', tour.glue.replace(/([\w$]+)\.manuallyAsync\s*=\s*!0/g, 'void 0')),
  '/bin/fallback.p2/fallback.js': '<!doctype html><title>index</title>',
  '/bin/echo.wasm': echoProgram(),
  '/bin/fail.wasm': failingProgram('went wrong\n', 3),
  '/bin/native': new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])
}

let disk: RealDiskFs

beforeEach(async () => {
  disk = await createRealDiskFs()
  vi.stubGlobal('location', { origin: ORIGIN })
  vi.stubGlobal('orivon', disk.orivon as Orivon)
  vi.stubGlobal('fetch', async (url: string) => {
    const bytes = PROGRAMS[new URL(url).pathname]
    return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes)
  })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  forkModules.clear()
  await disk.cleanup()
})

function events (child: ChildProcess): Promise<string[]> {
  const seen: string[] = []
  child.on('spawn', () => seen.push('spawn'))
  child.on('exit', (code, signal) => seen.push(`exit ${String(code)} ${String(signal)}`))
  child.on('error', (error: { code?: string }) => seen.push(`error ${error.code ?? ''}`))
  return new Promise((resolve) => child.on('close', (code, signal) => { seen.push(`close ${String(code)} ${String(signal)}`); resolve(seen) }))
}

describe.skipIf(!hasJspi)('spawn', () => {
  it('runs a WASI program: stdin in, stdout out, then exit and close in Node\'s order', async () => {
    const child = spawn('/bin/echo', ['arg'])
    const chunks: string[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
    const order = events(child)
    child.stdin?.write('hello ')
    child.stdin?.end('child')
    expect(await order).toEqual(['spawn', 'exit 0 null', 'close 0 null'])
    expect(chunks.join('')).toBe('hello child')
    expect(child.exitCode).toBe(0)
    expect(child.pid).toBeGreaterThan(1)
    expect(child.spawnargs).toEqual(['/bin/echo', 'arg'])
  })

  it('emits error then close for a missing program, with Node\'s ENOENT shape', async () => {
    const child = spawn('git', ['--version'])
    const errors: Array<{ code: string, syscall: string }> = []
    child.on('error', (error: { code: string, syscall: string }) => errors.push(error))
    await new Promise((resolve) => child.on('close', resolve))
    expect(errors[0]).toMatchObject({ code: 'ENOENT', syscall: 'spawn git' })
  })

  it('refuses a native program by name, with ENOEXEC', async () => {
    const child = spawn('/bin/native')
    const order = events(child)
    expect(await order).toEqual(['error ENOEXEC', 'close -8 null'])
  })

  it('kills a running program: its Worker is terminated and it reports the signal', async () => {
    const child = spawn('/bin/echo')
    const order = events(child)
    await new Promise((resolve) => child.once('spawn', resolve))
    expect(child.kill()).toBe(true)
    child.stdout?.resume()
    expect(await order).toEqual(['spawn', 'exit null SIGTERM', 'close null SIGTERM'])
    expect(child.killed).toBe(true)
    expect(workers.at(-1)?.terminated).toBe(true)
    expect(child.kill()).toBe(false)
  })

  it('answers kill(0) with whether the child runs, and emits exit only after kill() returns, as Node does', async () => {
    const child = spawn('/bin/echo')
    await new Promise((resolve) => child.once('spawn', resolve))
    expect(child.kill(0)).toBe(true)
    child.kill()
    const exit = new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)))
    expect(await exit).toBe('SIGTERM')
    expect(child.kill(0)).toBe(false)
  })

  it('reports a Worker that cannot be created as a spawn failure: error, then close', async () => {
    failNext.worker = true
    const child = spawn('/bin/echo')
    const order = events(child)
    expect(await order).toEqual(['error ENOEXEC', 'close -8 null'])
  })

  it('refuses a shell, an IPC channel and a uid by name', () => {
    expect(() => spawn('/bin/echo', [], { shell: true })).toThrow(OrivonShimError)
    expect(() => spawn('/bin/echo', [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })).toThrow(OrivonShimError)
    expect(() => spawn('/bin/echo', [], { uid: 0 })).toThrow(OrivonShimError)
  })
})

describe.skipIf(!hasJspi)('spawn a WASI 0.2 component', () => {
  it('runs its jco output: stdin in, stdout and stderr out, a file through orivon.fs, and its exit', async () => {
    const child = spawn('/bin/tour')
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Uint8Array) => { stdout += new TextDecoder().decode(chunk) })
    child.stderr?.on('data', (chunk: Uint8Array) => { stderr += new TextDecoder().decode(chunk) })
    const seen = events(child)
    child.stdin?.end('from spawn\n')
    expect(await seen).toEqual(['spawn', 'exit 1 null', 'close 1 null'])
    expect(stdout).toBe('from spawn\n')
    expect(stderr).toBe('done\n')
    expect(await disk.readRealFile('from-component.txt')).toBe('written by a component\n')
  })

  it('finds the output alone, with no .wasm beside it', async () => {
    const child = spawn('/bin/only')
    child.stdin?.end()
    expect(await events(child)).toContain('exit 1 null')
  })

  it('keeps a missing program ENOENT where the server answers every path with a fallback page', async () => {
    expect(await events(spawn('/bin/fallback'))).toEqual(['error ENOENT', 'close -2 null'])
  })

  it('refuses a component shipped without its jco output, naming the command to make it', async () => {
    const failure = new Promise<{ code?: string, message: string }>((resolve) => spawn('/bin/raw').on('error', resolve))
    expect(await failure).toMatchObject({ code: 'ENOEXEC', message: expect.stringMatching(/jco transpile \/bin\/raw\.wasm --name raw -o raw\.p2/) })
  })

  it('refuses output that lowers the host\'s asynchronous imports synchronously, naming them', async () => {
    const failure = new Promise<{ code?: string, message: string }>((resolve) => spawn('/bin/unmarked').on('error', resolve))
    expect(await failure).toMatchObject({ code: 'ENOEXEC', message: expect.stringContaining('wasi:io/streams#blockingWriteAndFlush') })
  })
})

describe.skipIf(!hasJspi)('execFile and exec', () => {
  it('buffers output for the callback, and gives a failed command Node\'s error shape', async () => {
    const result = await new Promise<{ error: unknown, stdout: unknown, stderr: unknown }>((resolve) => {
      execFile('/bin/fail', (error, stdout, stderr) => resolve({ error, stdout, stderr }))
    })
    expect(result.stderr).toBe('went wrong\n')
    expect(result.error).toMatchObject({ code: 3, killed: false, signal: null, cmd: '/bin/fail' })
  })

  it('resolves through util.promisify with stdout and stderr, as Node\'s execFile does', async () => {
    const run = promisify(execFile) as unknown as (file: string, args: string[]) => Promise<{ stdout: string, stderr: string }> & { child: ChildProcess }
    const pending = run('/bin/echo', [])
    pending.child.stdin?.end('piped')
    expect(await pending).toEqual({ stdout: 'piped', stderr: '' })
  })

  it('rejects through util.promisify for a missing program, so an "is it installed" check takes its branch', async () => {
    const run = promisify(execFile) as unknown as (file: string, args: string[]) => Promise<unknown>
    await expect(run('git', ['--version'])).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reads the options that follow an undefined args, as Node\'s execFile does', async () => {
    const error = await new Promise<unknown>((resolve) => {
      const child = execFile('/bin/echo', undefined, { maxBuffer: 2 }, (failure) => resolve(failure))
      child.stdin?.end('over two bytes')
    })
    expect(error).toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
  })

  it('stops a child whose output passes maxBuffer', async () => {
    const error = await new Promise<unknown>((resolve) => {
      const child = execFile('/bin/echo', [], { maxBuffer: 4 }, (failure) => resolve(failure))
      child.stdin?.end('more than four bytes')
    })
    expect(error).toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
  })

  it('splits exec\'s command into a program and arguments, and refuses one that needs a shell', async () => {
    const stderr = await new Promise<unknown>((resolve) => { exec('/bin/fail "an argument"', (_error, _stdout, err) => resolve(err)) })
    expect(stderr).toBe('went wrong\n')
    expect(() => exec('/bin/echo | grep x')).toThrow(OrivonShimError)
  })

  it('refuses the synchronous forms by name', () => {
    expect(() => execFileSync()).toThrow(OrivonShimError)
    expect(() => (childProcess as unknown as { spawnSync: () => void }).spawnSync()).toThrow(OrivonShimError)
  })
})

describe('fork', () => {
  it('runs an app module with IPC both ways, argv and the page\'s orivon', async () => {
    forkModules.set(`${ORIGIN}/child.js`, (scope) => {
      const proc = scope.process as unknown as { argv: string[], on: (event: string, listener: (message: unknown) => void) => void, send: (message: unknown) => void }
      proc.on('message', async (message) => {
        const orivon = scope.orivon as Orivon
        await orivon.fs.writeFile('from-child.txt', new TextEncoder().encode(String((message as { text: string }).text)))
        proc.send({ done: true, argv: proc.argv })
      })
    })
    const child = fork('/child.js', ['one'])
    const reply = new Promise((resolve) => child.once('message', resolve))
    child.send({ text: 'written by the child' })
    expect(await reply).toEqual({ done: true, argv: ['node', '/child.js', 'one'] })
    expect(await disk.readRealFile('from-child.txt')).toBe('written by the child')
    expect(child.connected).toBe(true)
    child.kill()
  })

  it('reports the module\'s process.exit code', async () => {
    forkModules.set(`${ORIGIN}/exits.js`, (scope) => { (scope.process as unknown as { exit: (code: number) => never }).exit(2) })
    const child = fork('/exits.js', [], { silent: true })
    const code = await new Promise((resolve) => child.once('exit', resolve))
    expect(code).toBe(2)
  })

  it('refuses a native execPath by name, and demands an IPC channel as Node does', () => {
    expect(() => fork('/child.js', [], { execPath: '/opt/helper' })).toThrow(OrivonShimError)
    expect(() => fork('/child.js', [], { stdio: 'pipe' })).toThrow(expect.objectContaining({ code: 'ERR_CHILD_PROCESS_IPC_REQUIRED' }))
  })

  it('warns once that execArgv is dropped, rather than silently ignoring it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = fork('/child.js', [], { execArgv: ['--first-flag'] })
    const second = fork('/child.js', [], { execArgv: ['--second-flag'] })
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('execArgv'))).toHaveLength(1)
    first.kill()
    second.kill()
  })
})
