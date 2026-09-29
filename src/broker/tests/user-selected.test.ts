import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBroker } from '../index.js'
import { nodeFs } from '../adapters/node-fs-adapter.js'
import { APP, baseDeps, manifestWith, memoryLedgerStorage, stubFs } from './index.test-helpers.js'
import { rejection } from '../handles/tests/handles.test-helpers.js'
import type { PickPathResult } from '../broker-contracts.js'
import type { FailableDirectoryHandle, FailableFileHandle } from '../handles/handle-contracts.js'

// L5-userselected: orivon.fs.userSelected end to end through a real
// createBroker -- confinement rooted at the PICKED path (never the app's
// own files directory), the cancel-is-not-a-rejection contract, persistence
// via a real LedgerStorage double, and both halves of the revocation
// exception handle-contracts.md's "FileHandle" section specifies. The
// handle-table mechanics (byPickedPath, revokeUserSelected) already have
// their own direct suite in ../handles/tests/handles.test.ts -- this file
// exercises the same guarantees through the real broker surface an app
// actually calls.

function pickedDirectory (path: string): () => Promise<PickPathResult> {
  return async () => ({ canceled: false, paths: [path] })
}

function pickedFiles (paths: readonly string[]): () => Promise<PickPathResult> {
  return async () => ({ canceled: false, paths })
}

const cancelled: () => Promise<PickPathResult> = async () => ({ canceled: true })

describe('orivon.fs.userSelected -- the folder shape', () => {
  it('returns a DirectoryHandle rooted at the picked path, not the app files directory', async () => {
    // stubFs's own `root` param only seeds its virtual directory tree so
    // `mkdir` has somewhere to land -- it is NOT `deps.fs.rootFor(origin)`
    // consulted anywhere below; userSelected never calls that. Set to the
    // PICKED path here purely so the stub believes it already exists, the
    // way a real OS picker only ever names a folder that really does.
    const broker = createBroker(baseDeps({
      fs: stubFs({ root: '/home/user/Downloads' }),
      pickPath: pickedDirectory('/home/user/Downloads')
    }))
    broker.registerApp(APP, manifestWith({}))

    const handle = await broker.fs.userSelected(APP, { directory: true })

    expect(handle).not.toBeNull()
    await (handle as FailableDirectoryHandle).mkdir('sub', undefined)
    // Proves the root really is the PICKED path: a write lands where the
    // picker pointed, never under the app's own confined files directory.
    await (handle as FailableDirectoryHandle).writeFile('sub/note.txt', new Uint8Array([1, 2, 3]))
    expect(await (handle as FailableDirectoryHandle).readFile('sub/note.txt')).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('resolves null, never a rejection, when the dialog is cancelled', async () => {
    const broker = createBroker(baseDeps({ pickPath: cancelled }))
    broker.registerApp(APP, manifestWith({}))

    await expect(broker.fs.userSelected(APP, { directory: true })).resolves.toBeNull()
  })

  it('rejects a path that escapes the picked root, the same as the app\'s own fs.rm would', async () => {
    const broker = createBroker(baseDeps({ pickPath: pickedDirectory('/home/user/Downloads') }))
    broker.registerApp(APP, manifestWith({}))
    const handle = await broker.fs.userSelected(APP, { directory: true }) as FailableDirectoryHandle

    const error = await rejection(handle.readFile('../../../etc/passwd'))

    expect(error.code).toBe('denied')
  })

  it('readdir/stat omitting path target the root itself', async () => {
    const broker = createBroker(baseDeps({
      fs: stubFs({ files: new Map([['/home/user/Downloads/a.txt', new Uint8Array(1)]]) }),
      pickPath: pickedDirectory('/home/user/Downloads')
    }))
    broker.registerApp(APP, manifestWith({}))
    const handle = await broker.fs.userSelected(APP, { directory: true }) as FailableDirectoryHandle

    expect(await handle.readdir()).toContain('a.txt')
    expect((await handle.stat()).isDirectory).toBe(true)
  })

  it('a nested open() shares the SAME pick as the directory, so revoking the folder closes it too', async () => {
    const storage = memoryLedgerStorage()
    const broker = createBroker(baseDeps({
      fs: stubFs({ files: new Map([['/home/user/Downloads/a.txt', new Uint8Array([9])]]) }),
      pickPath: pickedDirectory('/home/user/Downloads'),
      ledgerStorage: storage
    }))
    broker.registerApp(APP, manifestWith({}))
    const dir = await broker.fs.userSelected(APP, { directory: true }) as FailableDirectoryHandle
    const file = await dir.open('a.txt', 'r+')
    const [pick] = await broker.app.pickedPaths(APP)

    const removed = await broker.revokeUserSelectedPath(APP, pick!.id)

    expect(removed).toBe(true)
    await expect(rejection(file.read({ position: 0, length: 1 }))).resolves.toMatchObject({ code: 'revoked' })
  })
})

describe('orivon.fs.userSelected -- the file shape', () => {
  it('resolves an empty array, never a rejection, when the dialog is cancelled', async () => {
    const broker = createBroker(baseDeps({ pickPath: cancelled }))
    broker.registerApp(APP, manifestWith({}))

    await expect(broker.fs.userSelected(APP)).resolves.toEqual([])
  })

  it('opens each picked file read-write, confined to nothing but its own path', async () => {
    const broker = createBroker(baseDeps({
      fs: stubFs({ files: new Map([['/home/user/a.txt', new Uint8Array([1])], ['/home/user/b.txt', new Uint8Array([2])]]) }),
      pickPath: pickedFiles(['/home/user/a.txt', '/home/user/b.txt'])
    }))
    broker.registerApp(APP, manifestWith({}))

    const handles = await broker.fs.userSelected(APP, { multiple: true })

    expect(handles).toHaveLength(2)
    expect(await handles[0]!.read({ position: 0, length: 1 })).toEqual(new Uint8Array([1]))
    expect(await handles[1]!.read({ position: 0, length: 1 })).toEqual(new Uint8Array([2]))
  })

  it('each picked file gets its OWN pick -- revoking one leaves the other live', async () => {
    const broker = createBroker(baseDeps({
      fs: stubFs({ files: new Map([['/home/user/a.txt', new Uint8Array([1])], ['/home/user/b.txt', new Uint8Array([2])]]) }),
      pickPath: pickedFiles(['/home/user/a.txt', '/home/user/b.txt'])
    }))
    broker.registerApp(APP, manifestWith({}))
    const [a, b] = await broker.fs.userSelected(APP, { multiple: true }) as [FailableFileHandle, FailableFileHandle]
    const picks = await broker.app.pickedPaths(APP)
    const pickForA = picks.find((p) => p.path === '/home/user/a.txt')!

    await broker.revokeUserSelectedPath(APP, pickForA.id)

    await expect(rejection(a.read({ position: 0, length: 1 }))).resolves.toMatchObject({ code: 'revoked' })
    expect(await b.read({ position: 0, length: 1 })).toEqual(new Uint8Array([2]))
  })
})

describe('the revocation exception, both halves (handle-contracts.md "FileHandle")', () => {
  it('revoking the standing fs grant does NOT close a picked handle', async () => {
    const broker = createBroker(baseDeps({
      fs: stubFs({ files: new Map([['/home/user/Downloads/a.txt', new Uint8Array(1)]]) }),
      pickPath: pickedDirectory('/home/user/Downloads')
    }))
    broker.registerApp(APP, manifestWith({}))
    const grant = await broker.grant(APP, 'fs', [])
    const handle = await broker.fs.userSelected(APP, { directory: true }) as FailableDirectoryHandle

    await broker.revoke(APP, grant.id)

    // The picker choice is the authorisation, not the fs grant -- the
    // handle must still work after fs is gone.
    expect(await handle.readdir()).toContain('a.txt')
  })

  it('revoking the picked path itself DOES close the handle -- "WITHOUT THIS CASCADE THE REVOKE BUTTON LIES"', async () => {
    const broker = createBroker(baseDeps({
      fs: stubFs({ files: new Map([['/home/user/Downloads/a.txt', new Uint8Array(1)]]) }),
      pickPath: pickedDirectory('/home/user/Downloads')
    }))
    broker.registerApp(APP, manifestWith({}))
    const handle = await broker.fs.userSelected(APP, { directory: true }) as FailableDirectoryHandle
    const [pick] = await broker.app.pickedPaths(APP)

    await broker.revokeUserSelectedPath(APP, pick!.id)

    const error = await rejection(handle.readdir())
    expect(error.code).toBe('revoked')
  })
})

describe('persistence (D-0007: survives a restart)', () => {
  it('a pick is visible from broker.app.pickedPaths, and survives a fresh broker over the same storage', async () => {
    const storage = memoryLedgerStorage()
    const first = createBroker(baseDeps({ pickPath: pickedDirectory('/home/user/Downloads'), ledgerStorage: storage }))
    first.registerApp(APP, manifestWith({}))
    await first.fs.userSelected(APP, { directory: true })

    const [before] = await first.app.pickedPaths(APP)
    expect(before?.path).toBe('/home/user/Downloads')

    // A fresh broker, simulating a restart -- only `storage` carries over.
    const afterRestart = createBroker(baseDeps({ ledgerStorage: storage }))
    afterRestart.registerApp(APP, manifestWith({}))
    const [after] = await afterRestart.app.pickedPaths(APP)

    expect(after).toEqual(before)
  })

  it('a revoke persists too: the pick is gone after a simulated restart', async () => {
    const storage = memoryLedgerStorage()
    const first = createBroker(baseDeps({ pickPath: pickedDirectory('/home/user/Downloads'), ledgerStorage: storage }))
    first.registerApp(APP, manifestWith({}))
    await first.fs.userSelected(APP, { directory: true })
    const [pick] = await first.app.pickedPaths(APP)
    await first.revokeUserSelectedPath(APP, pick!.id)

    const afterRestart = createBroker(baseDeps({ ledgerStorage: storage }))
    afterRestart.registerApp(APP, manifestWith({}))

    expect(await afterRestart.app.pickedPaths(APP)).toEqual([])
  })
})

describe('the picker guard refuses Orivon\'s own data', () => {
  it('refuses a folder pick that IS the app data root, before it can seed another origin\'s grants', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-picker-guard-'))
    try {
      const broker = createBroker(baseDeps({
        fs: nodeFs(userData),
        pickPath: async () => ({ canceled: false, paths: [userData] })
      }))
      await broker.registerApp(APP, manifestWith({}))

      const dir = await broker.fs.userSelected(APP, { directory: true })

      expect(dir).toBeNull()
      // Refused before it ever reaches the picked-path ledger -- nothing
      // to revoke, nothing shown in settings for a pick that never landed.
      expect(await broker.app.pickedPaths(APP)).toEqual([])
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('refuses a folder pick that is an ANCESTOR of the app data root too, not just an exact match', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-picker-guard-'))
    try {
      const broker = createBroker(baseDeps({
        fs: nodeFs(userData),
        pickPath: async () => ({ canceled: false, paths: [dirname(userData)] })
      }))
      await broker.registerApp(APP, manifestWith({}))

      const dir = await broker.fs.userSelected(APP, { directory: true })

      expect(dir).toBeNull()
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('tells the person why, through the injected notification -- the APP still sees only a plain cancellation', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-picker-guard-'))
    try {
      const notifications: Array<{ origin: string, appName: string | undefined, reason: string }> = []
      const broker = createBroker(baseDeps({
        fs: nodeFs(userData),
        pickPath: async () => ({ canceled: false, paths: [userData] }),
        notifyPickRefused: (info) => { notifications.push(info) }
      }))
      await broker.registerApp(APP, manifestWith({}))

      const dir = await broker.fs.userSelected(APP, { directory: true })

      expect(dir).toBeNull() // indistinguishable from a person clicking Cancel
      // `manifestWith({})` names the app "Test app" -- an UNREGISTERED
      // origin would show `appName: undefined` here instead; either way
      // the app itself never sees this notification at all.
      expect(notifications).toEqual([{ origin: APP, appName: 'Test app', reason: "this folder holds Orivon's own data" }])
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('the same guard applies to a picked FILE, not only a folder -- an app cannot pick a single file inside userData either', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-picker-guard-'))
    try {
      const planted = join(userData, 'inside.txt')
      writeFileSync(planted, 'x') // realpathSync needs it to actually exist
      const broker = createBroker(baseDeps({
        fs: nodeFs(userData),
        pickPath: async () => ({ canceled: false, paths: [planted] })
      }))
      await broker.registerApp(APP, manifestWith({}))

      const files = await broker.fs.userSelected(APP)

      expect(files).toEqual([])
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
})

describe('one pending picker per origin', () => {
  it('a second fs.userSelected call for the SAME origin while one is still open is denied, not a second OS dialog', async () => {
    let releaseFirst: (() => void) | undefined
    const broker = createBroker(baseDeps({
      pickPath: async () => await new Promise((resolve) => { releaseFirst = () => { resolve({ canceled: true }) } })
    }))
    broker.registerApp(APP, manifestWith({}))

    const first = broker.fs.userSelected(APP, { directory: true })
    const second = await rejection(broker.fs.userSelected(APP, { directory: true }))

    expect(second.code).toBe('denied')
    releaseFirst?.()
    await expect(first).resolves.toBeNull()
  })

  it('a pending picker is cleared once it settles, so the SAME origin can pick again right after', async () => {
    const broker = createBroker(baseDeps({ pickPath: cancelled }))
    broker.registerApp(APP, manifestWith({}))

    await broker.fs.userSelected(APP, { directory: true })

    await expect(broker.fs.userSelected(APP, { directory: true })).resolves.toBeNull()
  })

  it('a DIFFERENT origin\'s picker is never blocked by another origin\'s pending one', async () => {
    // A resolver PER CALL, not one shared variable -- `pickPath` here is
    // one function serving both origins, so a single captured `resolve`
    // would be overwritten by the second call before the first is ever
    // released, hanging this test rather than testing anything.
    const releases: Array<() => void> = []
    const OTHER = 'https://other.example'
    const broker = createBroker(baseDeps({
      pickPath: async () => await new Promise((resolve) => { releases.push(() => { resolve({ canceled: true }) }) })
    }))
    broker.registerApp(APP, manifestWith({}))
    broker.registerApp(OTHER, manifestWith({}))

    const first = broker.fs.userSelected(APP, { directory: true })
    const otherCall = broker.fs.userSelected(OTHER, { directory: true })
    for (const release of releases) release()

    await expect(first).resolves.toBeNull()
    await expect(otherCall).resolves.toBeNull()
  })
})

describe('the fs write quota applies to a picked path too', () => {
  it('a write through a picked directory that would exceed the declared quota is refused with \'limit\'', async () => {
    const broker = createBroker(baseDeps({
      fs: stubFs(),
      pickPath: pickedDirectory('/home/user/Downloads')
    }))
    broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 2 } }))
    const handle = await broker.fs.userSelected(APP, { directory: true }) as FailableDirectoryHandle

    const error = await rejection(handle.writeFile('big.bin', new Uint8Array(10)))

    expect(error.code).toBe('limit')
  })
})
