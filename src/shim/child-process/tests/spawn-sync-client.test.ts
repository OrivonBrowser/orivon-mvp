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
    expect(cp.execFileSync('/bin/echo').toString()).toBe('ok')
  })

  it('execFileSync throws on a non-zero status, with status/signal/stdout/stderr on the error', async () => {
    installFakeSpawnSync(() => ({ pid: 1, stdout: new Uint8Array(0), stderr: new TextEncoder().encode('bad'), status: 3, signal: null }))
    const cp = await import('../index.js')
    let caught: unknown
    try { cp.execFileSync('/bin/fail') } catch (error) { caught = error }
    expect(caught).toMatchObject({ status: 3, signal: null, message: expect.stringContaining('Command failed') })
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
})
