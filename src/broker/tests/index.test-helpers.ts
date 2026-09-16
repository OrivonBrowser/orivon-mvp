// Shared fixtures for index.test.ts and its siblings (split out under
// code-guidelines.md's 800-line test limit, following handles.test-helpers.ts's
// own precedent). Not *.test.ts, so vitest does not collect it as its own suite.

import { vi } from 'vitest'
import { createBroker } from '../index.js'
import type { BoundUdpSocket, Broker, CreateBrokerOptions, DialedSocket, ListenedServer } from '../broker-contracts.js'
import type { LedgerStorage, PersistedGrant, PersistedPick } from '../grants/ledger-storage.js'
import type { Capabilities, Manifest } from '../../contracts/index.js'

export const APP = 'https://app.example'

/**
 * Spread into a hand-built `CreateBrokerOptions['fs']` literal that only
 * means to exercise readFile/writeFile -- BrokerFs.mkdir/readdir/stat/rm/
 * rename/open must still exist to satisfy the type, but a test built before
 * queue item 2.1 (or before orivon.fs.open) never calls them, so each one
 * fails loudly rather than silently succeeding if that ever stops being true.
 */
export function unusedFsExtras (): Pick<CreateBrokerOptions['fs'], 'mkdir' | 'readdir' | 'stat' | 'rm' | 'rename' | 'open'> {
  const notStubbed = (): never => { throw new Error('this stub method was not configured for this test') }
  return {
    mkdir: notStubbed,
    readdir: notStubbed,
    stat: notStubbed,
    rm: notStubbed,
    rename: notStubbed,
    open: notStubbed
  }
}

export function manifestWith (capabilities: Capabilities): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'org.orivon.test',
    name: 'Test app',
    version: '1.0.0',
    entry: '/index.html',
    capabilities
  }
}

/** A DialedSocket that never touches a real stream -- readable/writable are never read from in these tests. */
export function okSocket (overrides: Partial<DialedSocket> = {}): DialedSocket {
  return {
    readable: new ReadableStream(),
    writable: new WritableStream(),
    remoteAddress: '93.184.216.34',
    remotePort: 443,
    localAddress: '10.0.0.5',
    localPort: 54321,
    setNoDelay: async () => {},
    setKeepAlive: async () => {},
    destroy: vi.fn(),
    ...overrides
  }
}

/** A BoundUdpSocket that touches no real socket -- `readable` is never read from in these tests. */
export function okUdpSocket (overrides: Partial<BoundUdpSocket> = {}): BoundUdpSocket {
  return {
    readable: new ReadableStream(),
    send: async () => ({ sent: true }),
    localAddress: '0.0.0.0',
    localPort: 6881,
    droppedInbound: 0,
    destroy: vi.fn(),
    ...overrides
  }
}

/** A ListenedServer that never touches a real socket -- `accept()` never resolves unless a test overrides it. */
export function okListenedServer (overrides: Partial<ListenedServer> = {}): ListenedServer {
  return {
    localAddress: '0.0.0.0',
    localPort: 6881,
    accept: async () => await new Promise(() => {}),
    destroy: vi.fn(),
    ...overrides
  }
}

function enoent (): never {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

/**
 * A tiny in-memory directory tree backing `stubFs`'s mkdir/readdir/stat/rm/
 * rename -- just enough structure (a Set of directory paths alongside the
 * existing file Map) for index-fs-extended.test.ts's confinement and
 * grant-check assertions, which never need real symlinks, real permissions
 * or real disk errors -- those are node-adapters.test.ts's job, against a
 * real temp directory.
 */
function virtualDirs (files: Map<string, Uint8Array>, root: string): Set<string> {
  const dirs = new Set<string>([root])
  for (const path of files.keys()) {
    let dir = path.slice(0, path.lastIndexOf('/'))
    while (dir.length >= root.length) {
      dirs.add(dir)
      dir = dir.slice(0, dir.lastIndexOf('/'))
    }
  }
  return dirs
}

export function stubFs (options: { root?: string, files?: Map<string, Uint8Array> } = {}): CreateBrokerOptions['fs'] {
  const root = options.root ?? '/apps/app'
  const files = options.files ?? new Map<string, Uint8Array>()
  const dirs = virtualDirs(files, root)

  function isDir (path: string): boolean { return dirs.has(path) }
  function isFile (path: string): boolean { return files.has(path) }
  function childrenOf (path: string): string[] {
    const prefix = path.endsWith('/') ? path : `${path}/`
    const names = new Set<string>()
    for (const candidate of [...files.keys(), ...dirs]) {
      if (candidate === path || !candidate.startsWith(prefix)) continue
      const rest = candidate.slice(prefix.length)
      names.add(rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest)
    }
    return [...names]
  }

  return {
    rootFor: () => root,
    // Everything "exists" and resolves to itself. Confinement's own edge
    // cases (symlink escapes, Windows device names, ..) are policy/paths.ts's
    // suite; this file only has to prove createBroker calls it.
    realpathSync: (p) => p,
    readFile: async (path) => {
      const data = files.get(path)
      if (data === undefined) enoent()
      return data
    },
    writeFile: async (path, data) => {
      files.set(path, data)
      let dir = path.slice(0, path.lastIndexOf('/'))
      while (dir.length >= root.length) { dirs.add(dir); dir = dir.slice(0, dir.lastIndexOf('/')) }
    },
    mkdir: async (path, opts) => {
      if (!opts?.recursive) {
        if (!dirs.has(path.slice(0, path.lastIndexOf('/')))) enoent()
        dirs.add(path)
        return
      }
      // recursive:true creates every missing ancestor, matching real
      // node:fs/promises.mkdir -- not just the leaf, which is what left
      // an intermediate directory unlisted by readdir before this fix.
      let dir = path
      while (dir.length >= root.length) { dirs.add(dir); dir = dir.slice(0, dir.lastIndexOf('/')) }
    },
    readdir: async (path) => {
      if (!isDir(path)) enoent()
      return childrenOf(path)
    },
    stat: async (path) => {
      if (isFile(path)) return { size: files.get(path)!.length, isFile: true, isDirectory: false, mtimeMs: 0 }
      if (isDir(path)) return { size: 0, isFile: false, isDirectory: true, mtimeMs: 0 }
      enoent()
    },
    rm: async (path, opts) => {
      if (isFile(path)) { files.delete(path); return }
      if (!isDir(path)) enoent()
      const children = childrenOf(path)
      if (children.length > 0 && opts?.recursive !== true) throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' })
      const prefix = `${path}/`
      for (const candidate of [...files.keys()]) if (candidate === path || candidate.startsWith(prefix)) files.delete(candidate)
      for (const candidate of [...dirs]) if (candidate === path || candidate.startsWith(prefix)) dirs.delete(candidate)
    },
    rename: async (from, to) => {
      const parentOfTo = to.slice(0, to.lastIndexOf('/'))
      if (!dirs.has(parentOfTo)) enoent()
      if (isFile(from)) { files.set(to, files.get(from)!); files.delete(from); return }
      if (isDir(from)) { dirs.add(to); dirs.delete(from); return }
      enoent()
    },
    // A positional in-memory descriptor over the same `files` Map --
    // enough for fs-open.test.ts's confinement/grant/quota/revocation
    // assertions, which never need real fd/stream mechanics. Those are
    // node-fs-adapter-open.test.ts's job, against a real temp file.
    open: async (path, flags) => {
      const exists = files.has(path)
      if (flags.startsWith('r') && !exists) enoent()
      if (flags.includes('x') && exists) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      if (!exists) files.set(path, new Uint8Array(0))
      else if (flags.startsWith('w')) files.set(path, new Uint8Array(0))

      let destroyed = false
      function live (): Uint8Array {
        if (destroyed) throw Object.assign(new Error('EBADF'), { code: 'EBADF' })
        return files.get(path) ?? new Uint8Array(0)
      }

      return {
        read: async ({ position, length }) => {
          const data = live()
          return data.slice(position, Math.min(position + length, data.length))
        },
        write: async ({ position, data }) => {
          const current = live()
          const next = new Uint8Array(Math.max(current.length, position + data.length))
          next.set(current)
          next.set(data, position)
          files.set(path, next)
          return data.length
        },
        readable: (opts) => {
          const data = live()
          const start = opts?.start ?? 0
          const end = opts?.end ?? data.length
          const slice = data.slice(start, Math.max(start, end))
          return new ReadableStream<Uint8Array>({ start (controller) { controller.enqueue(slice); controller.close() } })
        },
        // Writes land immediately -- there is no queue to lose on destroy(),
        // so this stub has no A84-style conditional teardown to fake.
        // node-fs-adapter-open.test.ts proves that against a real stream.
        writable: (opts) => {
          let offset = opts?.start ?? 0
          return new WritableStream<Uint8Array>({
            write (chunk) {
              const current = live()
              const next = new Uint8Array(Math.max(current.length, offset + chunk.byteLength))
              next.set(current)
              next.set(chunk, offset)
              files.set(path, next)
              offset += chunk.byteLength
            }
          })
        },
        stat: async () => {
          const data = live()
          return { size: data.length, isFile: true, isDirectory: false, mtimeMs: 0 }
        },
        truncate: async (length) => {
          const current = live()
          const next = new Uint8Array(length)
          next.set(current.subarray(0, Math.min(length, current.length)))
          files.set(path, next)
        },
        sync: async () => { live() },
        destroy: async () => { destroyed = true }
      }
    }
  }
}

/**
 * Spreads `overrides` last, rather than enumerating each known key with its
 * own `??` fallback. The enumerated form silently drops any key this
 * function has not been updated to name: `baseDeps({ ledgerStorage:
 * someStorage })` would build a broker with no persistence at all, and
 * nothing anywhere would signal the drop -- a caller only finds out by a
 * test failing to behave like it was configured.
 */
export function baseDeps (overrides: Partial<CreateBrokerOptions> = {}): CreateBrokerOptions {
  return {
    dial: async () => okSocket(),
    dialSecure: async () => okSocket(),
    bind: async () => okUdpSocket(),
    listen: async () => okListenedServer(),
    resolve: async () => [],
    resolveLookup: async () => [],
    now: () => 0,
    fs: stubFs(),
    keychain: { getSeed: async () => new Uint8Array(32) },
    pickPath: async () => ({ canceled: true }),
    ...overrides
  }
}

/** A Map-backed LedgerStorage double -- real behaviour, no disk, matching grant-ledger.test.ts's own local copy of the same idiom. */
export function memoryLedgerStorage (): LedgerStorage & {
  readonly floors: Map<string, string>
  readonly rollbackAcks: Map<string, string>
  readonly grants: Map<string, Readonly<Record<string, PersistedGrant>>>
  readonly declined: Map<string, readonly string[]>
  readonly pickedPaths: Map<string, Readonly<Record<string, PersistedPick>>>
} {
  const floors = new Map<string, string>()
  const rollbackAcks = new Map<string, string>()
  const grants = new Map<string, Readonly<Record<string, PersistedGrant>>>()
  const names = new Map<string, string>()
  const declined = new Map<string, readonly string[]>()
  const pickedPaths = new Map<string, Readonly<Record<string, PersistedPick>>>()
  return {
    floors,
    rollbackAcks,
    grants,
    declined,
    pickedPaths,
    readVersionFloor: (origin) => floors.get(origin),
    writeVersionFloor: (origin, versionFloor) => { floors.set(origin, versionFloor) },
    deleteVersionFloor: (origin) => { floors.delete(origin) },
    readAcknowledgedRollbackVersion: (origin) => rollbackAcks.get(origin),
    writeAcknowledgedRollbackVersion: (origin, version) => { rollbackAcks.set(origin, version) },
    deleteAcknowledgedRollbackVersion: (origin) => { rollbackAcks.delete(origin) },
    readGrants: (origin) => grants.get(origin),
    writeGrants: (origin, originGrants, appName) => {
      grants.set(origin, originGrants)
      if (appName !== undefined) names.set(origin, appName)
    },
    deleteGrants: (origin) => { grants.delete(origin) },
    listPersistedOrigins: () => [...new Set([...grants.keys(), ...pickedPaths.keys()])],
    readPersistedApp: (origin: string) => {
      const g = grants.get(origin)
      const p = pickedPaths.get(origin)
      if (g === undefined && p === undefined) return undefined
      return { origin, appName: names.get(origin), grants: g ?? {}, pickedPaths: p ?? {} }
    },
    readDeclinedCapabilities: (origin) => declined.get(origin),
    writeDeclinedCapabilities: (origin, capabilities) => { declined.set(origin, capabilities) },
    deleteDeclinedCapabilities: (origin) => { declined.delete(origin) },
    readPickedPaths: (origin) => pickedPaths.get(origin),
    writePickedPaths: (origin, picks, appName) => {
      pickedPaths.set(origin, picks)
      if (appName !== undefined) names.set(origin, appName)
    },
    deletePickedPaths: (origin) => { pickedPaths.delete(origin) }
  }
}

/** A broker with `APP` registered and granted `tcp.connect` for one address -- the setup every net.connect/fail test below needs. */
export async function brokerWithConnectGrant (deps: Partial<CreateBrokerOptions> = {}): Promise<Broker> {
  const broker = createBroker(baseDeps(deps))
  broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
  await broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])
  return broker
}

/** `brokerWithConnectGrant`'s https.connect sibling -- a SEPARATE grant, matched by hostname (ADR-0017). */
export async function brokerWithConnectSecureGrant (deps: Partial<CreateBrokerOptions> = {}): Promise<Broker> {
  const broker = createBroker(baseDeps(deps))
  broker.registerApp(APP, manifestWith({ net: { https: { connect: ['api.example.com:443'] } } }))
  await broker.grant(APP, 'https.connect', ['api.example.com:443'])
  return broker
}
