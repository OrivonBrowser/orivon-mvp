// spawnSync/execSync/execFileSync's client-side half (child-process/index.ts):
// argument parsing, encoding, Node's result shape, and the two refusals
// (the page, and a Worker with no SharedArrayBuffer) -- proven with a fake
// SPAWN_SYNC function standing in for the real Worker's synchronous channel,
// the same pattern src/shim/fs/tests/sync.test.ts uses for the fs twin.
// spawn-sync.test.ts (child-process.test.ts's own runSpawnSync describe
// block) proves the SERVER-side half against real WASI programs; this file
// never runs one.

import { Buffer } from 'buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../../contracts/capability-api.js'
import { SPAWN_SYNC } from '../../worker/sync-channel.js'
import type { SpawnSyncRequest, SpawnSyncWireResult } from '../spawn-sync.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

function installFakeSpawnSync (run: (payload: SpawnSyncRequest) => SpawnSyncWireResult): SpawnSyncRequest[] {
  const calls: SpawnSyncRequest[] = []
  ;(globalThis as GlobalWithOrivon).orivon = {
    [SPAWN_SYNC]: (payload: unknown) => {
      calls.push(payload as SpawnSyncRequest)
      return run(payload as SpawnSyncRequest)
    }
  } as unknown as Orivon
  return calls
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

describe('on the page, or in a Worker with no SharedArrayBuffer', () => {
  it('refuse by name, naming where they do work', async () => {
    ;(globalThis as GlobalWithOrivon).orivon = {} as unknown as Orivon
    const cp = await import('../index.js')
    expect(() => cp.spawnSync('/bin/echo')).toThrow(/forked child or a worker_threads.Worker/)
    expect(() => cp.execSync('/bin/echo')).toThrow(/forked child or a worker_threads.Worker/)
    expect(() => cp.execFileSync('/bin/echo')).toThrow(/forked child or a worker_threads.Worker/)
  })
})

describe('over the synchronous channel', () => {
  it('spawnSync sends the command and args, and returns Node\'s result shape with encoding applied', async () => {
    const calls = installFakeSpawnSync(() => ({
      pid: 7, stdout: new TextEncoder().encode('out'), stderr: new TextEncoder().encode(''), status: 0, signal: null
    }))
    const cp = await import('../index.js')
    const result = cp.spawnSync('/bin/echo', ['a'], { encoding: 'utf8' })
    expect(result).toMatchObject({ pid: 7, stdout: 'out', stderr: '', status: 0, signal: null, output: [null, 'out', ''] })
    expect(calls[0]).toMatchObject({ command: '/bin/echo', args: ['a'] })
  })

  it('defaults to Buffer output, and passes input, cwd, timeout, killSignal and a default maxBuffer', async () => {
    const calls = installFakeSpawnSync(() => ({ pid: 1, stdout: new Uint8Array([1, 2]), stderr: new Uint8Array(0), status: 0, signal: null }))
    const cp = await import('../index.js')
    const result = cp.spawnSync('/bin/echo', [], { input: 'hi', cwd: '/orivon/app/x', timeout: 10, killSignal: 'SIGKILL' })
    expect(Buffer.isBuffer(result.stdout)).toBe(true)
    expect(calls[0]).toMatchObject({ cwd: '/orivon/app/x', timeout: 10, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 })
    expect(new TextDecoder().decode(calls[0]?.input)).toBe('hi')
  })

  it('execFileSync returns stdout alone', async () => {
    installFakeSpawnSync(() => ({ pid: 1, stdout: new TextEncoder().encode('ok'), stderr: new Uint8Array(0), status: 0, signal: null }))
    const cp = await import('../index.js')
    expect(cp.execFileSync('/bin/echo')?.toString()).toBe('ok')
  })

  it('execFileSync throws on a non-zero status, with status/signal/pid/output/stdout/stderr on the error', async () => {
    installFakeSpawnSync(() => ({ pid: 42, stdout: new Uint8Array(0), stderr: new TextEncoder().encode('bad'), status: 3, signal: null }))
    const cp = await import('../index.js')
    let caught: unknown
    try { cp.execFileSync('/bin/fail') } catch (error) { caught = error }
    expect(caught).toMatchObject({
      pid: 42, status: 3, signal: null, stdout: expect.anything(), stderr: expect.anything(),
      output: [null, expect.anything(), expect.anything()], message: 'Command failed: /bin/fail\nbad'
    })
  })

  // Finding 12: Node appends '\n<stderr>' to the "Command failed" message
  // only when stderr is non-empty -- this used to append it (an empty line)
  // unconditionally.
  it('"Command failed" omits the trailing "\\n<stderr>" when stderr is empty', async () => {
    installFakeSpawnSync(() => ({ pid: 1, stdout: new Uint8Array(0), stderr: new Uint8Array(0), status: 1, signal: null }))
    const cp = await import('../index.js')
    let caught: unknown
    try { cp.execFileSync('/bin/fail') } catch (error) { caught = error }
    expect((caught as Error).message).toBe('Command failed: /bin/fail')
  })

  // Finding 12: on a real spawn failure (result.error), Node still puts
  // pid/output/stdout/stderr/status/signal onto the thrown error -- not just
  // the bare wire error, so `catch (e) { e.stdout.toString() }` works.
  it('execFileSync on a real spawn failure (result.error) also carries pid/output/stdout/stderr/status/signal', async () => {
    installFakeSpawnSync(() => ({
      pid: undefined, stdout: new Uint8Array(0), stderr: new Uint8Array(0), status: null, signal: null,
      error: { name: 'Error', message: 'spawnSync /bin/missing ENOENT', code: 'ENOENT' }
    }))
    const cp = await import('../index.js')
    let caught: unknown
    try { cp.execFileSync('/bin/missing') } catch (error) { caught = error }
    expect(caught).toMatchObject({
      code: 'ENOENT', pid: undefined, status: null, signal: null, stdout: expect.anything(), stderr: expect.anything(),
      output: [null, expect.anything(), expect.anything()]
    })
  })

  it('execSync splits the command into a program and arguments, and refuses one that needs a shell', async () => {
    const calls = installFakeSpawnSync(() => ({ pid: 1, stdout: new Uint8Array(0), stderr: new Uint8Array(0), status: 0, signal: null }))
    const cp = await import('../index.js')
    cp.execSync('/bin/echo "an argument"')
    expect(calls[0]).toMatchObject({ command: '/bin/echo', args: ['an argument'] })
    expect(() => cp.execSync('/bin/echo | grep x')).toThrow(/needs a shell/)
  })

  it('spawnSync itself never throws on a non-zero status -- only .error is exceptional', async () => {
    installFakeSpawnSync(() => ({ pid: 1, stdout: new Uint8Array(0), stderr: new Uint8Array(0), status: 7, signal: null }))
    const cp = await import('../index.js')
    expect(cp.spawnSync('/bin/echo').status).toBe(7)
  })

  it('spawnSync reports a real spawn failure as .error, mapped from the wire', async () => {
    installFakeSpawnSync(() => ({
      pid: undefined, stdout: new Uint8Array(0), stderr: new Uint8Array(0), status: null, signal: null,
      error: { name: 'Error', message: 'spawn git ENOENT', code: 'ENOENT' }
    }))
    const cp = await import('../index.js')
    const result = cp.spawnSync('git', ['--version'])
    expect(result.error).toMatchObject({ code: 'ENOENT', message: 'spawn git ENOENT' })
  })

  // Finding 12: errno/syscall/path/spawnargs used to be dropped between the
  // wire and the Error the caller sees -- only name/message/code survived.
  it('spawnSync carries errno/syscall/path/spawnargs from the wire error onto the real Error', async () => {
    installFakeSpawnSync(() => ({
      pid: undefined, stdout: new Uint8Array(0), stderr: new Uint8Array(0), status: null, signal: null,
      error: {
        name: 'Error', message: 'spawnSync git ENOENT', code: 'ENOENT',
        errno: -2, syscall: 'spawnSync git', path: 'git', spawnargs: ['git', '--version']
      }
    }))
    const cp = await import('../index.js')
    const result = cp.spawnSync('git', ['--version'])
    expect(result.error).toMatchObject({
      code: 'ENOENT', errno: -2, syscall: 'spawnSync git', path: 'git', spawnargs: ['git', '--version']
    })
  })
})

// Finding 6/12: an argument spawn() itself would reject synchronously (a
// non-string or empty command) used to reach the fake sync channel anyway
// and come back as `result.error`, since nothing validated it on this side
// first -- Node throws these before ever blocking.
describe('argument errors throw synchronously, never reaching the sync channel', () => {
  it('an empty command', async () => {
    const calls = installFakeSpawnSync(() => { throw new Error('must not be called') })
    const cp = await import('../index.js')
    expect(() => cp.spawnSync('')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }))
    expect(() => cp.execFileSync('')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }))
    expect(calls).toEqual([])
  })

  it('a non-string command', async () => {
    const calls = installFakeSpawnSync(() => { throw new Error('must not be called') })
    const cp = await import('../index.js')
    expect(() => cp.spawnSync(123 as unknown as string)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
    expect(calls).toEqual([])
  })
})

describe('stdio: pipe/ignore/inherit are honoured; anything else refuses by name', () => {
  it('the default and \'pipe\' both request pipe on the wire', async () => {
    const calls = installFakeSpawnSync(() => ({ pid: 1, stdout: new Uint8Array(0), stderr: new Uint8Array(0), status: 0, signal: null }))
    const cp = await import('../index.js')
    cp.spawnSync('/bin/echo')
    cp.spawnSync('/bin/echo', [], { stdio: 'pipe' })
    expect(calls.map((c) => c.stdio)).toEqual(['pipe', 'pipe'])
  })

  it('\'ignore\' and \'inherit\' both reach the wire, and the result carries null output, not empty bytes', async () => {
    const calls = installFakeSpawnSync(() => ({ pid: 1, stdout: null, stderr: null, status: 0, signal: null }))
    const cp = await import('../index.js')
    const ignored = cp.spawnSync('/bin/echo', [], { stdio: 'ignore' })
    const inherited = cp.spawnSync('/bin/echo', [], { stdio: 'inherit' })
    expect(calls.map((c) => c.stdio)).toEqual(['ignore', 'inherit'])
    expect(ignored).toMatchObject({ stdout: null, stderr: null, output: [null, null, null] })
    expect(inherited).toMatchObject({ stdout: null, stderr: null, output: [null, null, null] })
  })

  it('execFileSync/execSync return null, not a buffer, when stdio is not \'pipe\'', async () => {
    installFakeSpawnSync(() => ({ pid: 1, stdout: null, stderr: null, status: 0, signal: null }))
    const cp = await import('../index.js')
    expect(cp.execFileSync('/bin/echo', [], { stdio: 'inherit' })).toBeNull()
  })

  it('a per-stream array, a stream or a bare fd refuses by name, never reaching the wire', async () => {
    const calls = installFakeSpawnSync(() => { throw new Error('must not be called') })
    const cp = await import('../index.js')
    expect(() => cp.spawnSync('/bin/echo', [], { stdio: ['pipe', 'pipe', 'pipe'] })).toThrow(/pipe.*ignore.*inherit/)
    expect(calls).toEqual([])
  })
})
