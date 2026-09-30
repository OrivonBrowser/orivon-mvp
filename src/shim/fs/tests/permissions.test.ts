// The chmod family succeeds after an existence check; chown stays refused
// (fs.test.ts). Stubs orivon.fs the way fs.test.ts does.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../../contracts/capability-api.js'
import { VIRTUAL_ROOT } from '../../virtual-root.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

function notFound (): Error { return Object.assign(new Error('no such file'), { name: 'OrivonError', code: 'notFound', platformCode: 'ENOENT' }) }

function install (): void {
  const present = new Set(['users', 'users/a.json'])
  ;(globalThis as GlobalWithOrivon).orivon = {
    fs: {
      stat: async (path: string) => {
        if (!present.has(path)) throw notFound()
        return { size: 0, isFile: path.endsWith('.json'), isDirectory: !path.endsWith('.json'), mtimeMs: 0 }
      },
      readFileSync: (path: string) => {
        if (!present.has(path)) throw notFound()
        return new Uint8Array(0)
      },
      open: async (path: string) => {
        if (!present.has(path)) throw notFound()
        return { read: async () => new Uint8Array(0), write: async () => 0, close: async () => undefined, stat: async () => ({ size: 0, isFile: true, isDirectory: false, mtimeMs: 0 }), truncate: async () => undefined, sync: async () => undefined }
      }
    }
  } as unknown as Orivon
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

describe('chmod family', () => {
  it('chmod succeeds on an existing path, in every mode form', async () => {
    install()
    const fs = await import('../fs.js')
    for (const mode of [0o700, '0700', '755']) {
      await new Promise<void>((resolve, reject) => { fs.chmod('users', mode, (error) => (error === null ? resolve() : reject(error))) })
    }
    await new Promise<void>((resolve, reject) => { fs.lchmod(`${VIRTUAL_ROOT}/users/a.json`, 0o600, (error) => (error === null ? resolve() : reject(error))) })
  })

  it('chmod on a missing path fails ENOENT', async () => {
    install()
    const fs = await import('../fs.js')
    const error = await new Promise<Error | null>((resolve) => { fs.chmod('missing', 0o700, resolve) })
    expect((error as Error & { code: string }).code).toBe('ENOENT')
  })

  it('chmodSync succeeds on an existing path (on a page too) and fails ENOENT on a missing one', async () => {
    install()
    const fs = await import('../fs.js')
    expect(() => fs.chmodSync('users/a.json', '0700')).not.toThrow()
    expect(() => fs.lchmodSync('users/a.json', 0o700)).not.toThrow()
    expect(() => fs.chmodSync('missing', 0o700)).toThrowError(expect.objectContaining({ code: 'ENOENT' }) as Error)
  })

  it('validates the mode as Node does', async () => {
    install()
    const fs = await import('../fs.js')
    expect(() => fs.chmodSync('users', 'rwx')).toThrowError(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }) as Error)
    expect(() => fs.chmodSync('users', undefined)).toThrowError(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }) as Error)
  })

  it('fs.promises.chmod and lchmod succeed, and fail ENOENT for a missing path', async () => {
    install()
    const { promises } = await import('../fs.js')
    await expect(promises.chmod('users', 0o700)).resolves.toBeUndefined()
    await expect(promises.lchmod('users', 0o700)).resolves.toBeUndefined()
    await expect(promises.chmod('missing', 0o700)).rejects.toMatchObject({ code: 'ENOENT' })
    const named = await import('../promises.js')
    await expect(named.chmod('users/a.json', '600')).resolves.toBeUndefined()
  })

  it('fchmod succeeds on an open descriptor and fails EBADF on any other', async () => {
    install()
    const fs = await import('../fs.js')
    const fd = await new Promise<number>((resolve, reject) => { fs.open('users/a.json', (error, result) => (error === null ? resolve(result as number) : reject(error))) })
    expect(await new Promise((resolve) => { fs.fchmod(fd, 0o600, resolve) })).toBeNull()
    expect((await new Promise<Error>((resolve) => { fs.fchmod(9999, 0o600, (error) => resolve(error as Error)) }) as Error & { code: string }).code).toBe('EBADF')
    expect(() => fs.fchmodSync(9999, 0o600)).toThrowError(expect.objectContaining({ code: 'EBADF' }) as Error)
    const handle = await fs.promises.open('users/a.json')
    await expect(handle.chmod(0o600)).resolves.toBeUndefined()
  })
})
