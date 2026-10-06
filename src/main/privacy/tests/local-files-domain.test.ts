import { describe, expect, it, vi } from 'vitest'
import { localFilesDomain } from '../local-files-domain.js'
import type { InternalCaller } from '../../pages/internal-ipc.js'

const CALLER = {} as InternalCaller
const A = 'file:///home/u/notes/a.html'
const B = 'file:///home/u/gone/b.html'

function domain (over: { missing?: string[], deleted?: boolean } = {}) {
  const deleteFile = vi.fn(async (_key: string) => over.deleted ?? true)
  const clearShared = vi.fn(async () => {})
  const handle = localFilesDomain({
    list: () => [A, B],
    exists: (path) => !(over.missing ?? []).includes(path),
    deleteFile,
    clearShared,
    platform: 'linux'
  }).handle
  return { handle: async (command: unknown): Promise<unknown> => await handle(command, CALLER), deleteFile, clearShared }
}

describe('the local files settings domain', () => {
  it('is for the settings page only', () => {
    expect(localFilesDomain({ list: () => [], exists: () => true, deleteFile: async () => true, clearShared: async () => {} }).pages).toEqual(['settings'])
  })

  it('lists each recorded file by the path it names and whether it is still there, under an id main minted', async () => {
    const { handle } = domain({ missing: ['/home/u/gone/b.html'] })
    const reply = await handle({ type: 'list' }) as { files: Array<{ id: string, path: string, missing: boolean }> }
    expect(reply.files.map(({ path, missing }) => ({ path, missing }))).toEqual([{ path: '/home/u/notes/a.html', missing: false }, { path: '/home/u/gone/b.html', missing: true }])
    expect(reply.files.every((file) => /^[0-9a-f]{16}$/.test(file.id))).toBe(true)
    expect(JSON.stringify(reply)).not.toContain('file:///')
  })

  it('deletes one file by an id it listed, and refuses an id it did not', async () => {
    const { handle, deleteFile } = domain()
    const reply = await handle({ type: 'list' }) as { files: Array<{ id: string }> }
    expect(await handle({ type: 'delete', id: reply.files[0]?.id })).toEqual({ ok: true })
    expect(deleteFile).toHaveBeenCalledExactlyOnceWith(A)
    expect(await handle({ type: 'delete', id: 'ffffffffffffffff' })).toBeUndefined()
    expect(await handle({ type: 'delete', id: 7 })).toBeUndefined()
    expect(deleteFile).toHaveBeenCalledTimes(1)
  })

  it('refuses to delete before a list has been read, and says when a delete did not complete', async () => {
    const early = domain()
    expect(await early.handle({ type: 'delete', id: 'ffffffffffffffff' })).toBeUndefined()
    const failing = domain({ deleted: false })
    const reply = await failing.handle({ type: 'list' }) as { files: Array<{ id: string }> }
    expect(await failing.handle({ type: 'delete', id: reply.files[1]?.id })).toEqual({ ok: false })
  })

  it('clears what files that were never recorded keep together, and answers nothing to anything else', async () => {
    const { handle, clearShared } = domain()
    expect(await handle({ type: 'clearShared' })).toEqual({ ok: true })
    expect(clearShared).toHaveBeenCalledOnce()
    expect(await handle({ type: 'nope' })).toBeUndefined()
    expect(await handle(null)).toBeUndefined()
  })
})
