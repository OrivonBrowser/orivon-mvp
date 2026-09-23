// The one virtual root every Node-shaped path in an app tab agrees on
// (virtual-root.ts): the fs shim strips it to the confined relative path
// orivon.fs takes, answers the root itself locally, and refuses a path
// outside it with a Node errno rather than the broker's 'denied'.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../contracts/capability-api.js'
import { VIRTUAL_ROOT, VIRTUAL_TMPDIR } from '../virtual-root.js'
import { createFakeFileHandle } from './support/fake-file-handle.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

interface Call { readonly op: string, readonly args: readonly unknown[] }

function installFakeOrivon (): Call[] {
  const calls: Call[] = []
  const record = (op: string) => async (...args: unknown[]) => { calls.push({ op, args }) }
  ;(globalThis as GlobalWithOrivon).orivon = {
    fs: {
      readFile: async (...args: unknown[]) => { calls.push({ op: 'readFile', args }); return new Uint8Array([1]) },
      readFileSync: (...args: unknown[]) => { calls.push({ op: 'readFileSync', args }); return new Uint8Array([1]) },
      writeFile: record('writeFile'),
      mkdir: record('mkdir'),
      rm: record('rm'),
      rename: record('rename'),
      readdir: async (...args: unknown[]) => { calls.push({ op: 'readdir', args }); return [] },
      stat: async (...args: unknown[]) => { calls.push({ op: 'stat', args }); return { size: 1, isFile: true, isDirectory: false, mtimeMs: 0 } },
      open: async (...args: unknown[]) => { calls.push({ op: 'open', args }); return createFakeFileHandle().handle }
    }
  } as unknown as Orivon
  return calls
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

describe('a path under the virtual root', () => {
  it('reaches orivon.fs as the confined relative path', async () => {
    const calls = installFakeOrivon()
    const { promises } = await import('../node-fs.js')
    await promises.readFile(`${VIRTUAL_ROOT}/settings.db`)
    await promises.writeFile(`${VIRTUAL_ROOT}/a/b.txt`, 'x')
    await promises.readFile(`${VIRTUAL_ROOT}/./x/../y`)
    await promises.rename(`${VIRTUAL_ROOT}/a`, `${VIRTUAL_ROOT}/b`)
    expect(calls.map(({ op, args }) => [op, args[0], op === 'rename' ? args[1] : undefined])).toEqual([
      ['readFile', 'settings.db', undefined],
      ['writeFile', 'a/b.txt', undefined],
      ['readFile', 'y', undefined],
      ['rename', 'a', 'b']
    ])
  })

  it('works for fs.open, the streams and readFileSync alike', async () => {
    const calls = installFakeOrivon()
    const fs = await import('../node-fs.js')
    await fs.promises.open(`${VIRTUAL_ROOT}/f`, 'w')
    fs.createReadStream(`${VIRTUAL_ROOT}/g`).on('error', () => {}).resume()
    fs.readFileSync(`${VIRTUAL_ROOT}/h`)
    await vi.waitFor(() => { expect(calls.filter(({ op }) => op === 'open')).toHaveLength(2) })
    expect(calls.map(({ op, args }) => [op, args[0]])).toEqual([['open', 'f'], ['readFileSync', 'h'], ['open', 'g']])
  })

  it('accepts a file: URL and a Buffer path, as Node does', async () => {
    const calls = installFakeOrivon()
    const { promises } = await import('../node-fs.js')
    await promises.readFile(new URL(`file://${VIRTUAL_ROOT}/u`) as unknown as string)
    await promises.readFile(new TextEncoder().encode(`${VIRTUAL_ROOT}/v`) as unknown as string)
    expect(calls.map(({ args }) => args[0])).toEqual(['u', 'v'])
  })

  it('leaves a relative path exactly as written', async () => {
    const calls = installFakeOrivon()
    const { promises } = await import('../node-fs.js')
    await promises.readFile('./a/../b')
    expect(calls[0]?.args[0]).toBe('./a/../b')
  })
})

describe('a path outside the virtual root', () => {
  it.each([
    ['an absolute path elsewhere', '/etc/passwd'],
    ['a sibling of the root', `${VIRTUAL_ROOT}-other/x`],
    ['a traversal out of the root', `${VIRTUAL_ROOT}/../x`],
    ['a relative traversal', '../x']
  ])('%s fails EACCES without reaching orivon.fs', async (_label, path) => {
    const calls = installFakeOrivon()
    const { promises } = await import('../node-fs.js')
    const error = await promises.readFile(path).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'EACCES', errno: -13, syscall: 'open', path })
    expect(calls).toEqual([])
  })

  it('fails the same way synchronously for readFileSync', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    expect(() => fs.readFileSync('/etc/hosts')).toThrow(expect.objectContaining({ code: 'EACCES' }))
  })

  it('refuses either side of a rename', async () => {
    const calls = installFakeOrivon()
    const { promises } = await import('../node-fs.js')
    await expect(promises.rename(`${VIRTUAL_ROOT}/a`, '/tmp/b')).rejects.toMatchObject({ code: 'EACCES', syscall: 'rename' })
    expect(calls).toEqual([])
  })
})

describe('the root itself', () => {
  it.each([VIRTUAL_ROOT, `${VIRTUAL_ROOT}/`, '.', './'])('stat(%s) is a directory, answered locally', async (path) => {
    const calls = installFakeOrivon()
    const { promises } = await import('../node-fs.js')
    const stat = await promises.stat(path)
    expect(stat.isDirectory()).toBe(true)
    expect(stat.isFile()).toBe(false)
    expect(calls).toEqual([])
  })

  it('access() succeeds locally', async () => {
    const calls = installFakeOrivon()
    const { promises } = await import('../node-fs.js')
    await expect(promises.access(VIRTUAL_ROOT)).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })

  it('readdir() fails EACCES, naming the gap: the broker cannot list the root', async () => {
    const calls = installFakeOrivon()
    const { promises } = await import('../node-fs.js')
    const error = await promises.readdir(VIRTUAL_ROOT).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'EACCES', syscall: 'scandir' })
    expect(String((error as Error).message)).toMatch(/root/)
    expect(calls).toEqual([])
  })

  it('mkdir -p and open(r) keep their local answers when written absolute', async () => {
    const calls = installFakeOrivon()
    const { promises } = await import('../node-fs.js')
    await promises.mkdir(VIRTUAL_ROOT, { recursive: true })
    const handle = await promises.open(VIRTUAL_ROOT, 'r')
    await handle.close()
    expect(calls).toEqual([])
  })
})

describe('the virtual tmpdir', () => {
  it('is created once, on first use, before the call that needs it', async () => {
    const calls = installFakeOrivon()
    const { promises } = await import('../node-fs.js')
    await promises.writeFile(`${VIRTUAL_TMPDIR}/a`, 'x')
    await promises.writeFile(`${VIRTUAL_TMPDIR}/b`, 'y')
    expect(calls.map(({ op, args }) => [op, args[0], args[1]])).toEqual([
      ['mkdir', 'tmp', { recursive: true }],
      ['writeFile', 'tmp/a', expect.anything()],
      ['writeFile', 'tmp/b', expect.anything()]
    ])
  })
})
