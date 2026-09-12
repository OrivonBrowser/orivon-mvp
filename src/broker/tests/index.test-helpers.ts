// Shared fixtures for index.test.ts and its siblings (split out under
// code-guidelines.md's 800-line test limit, following handles.test-helpers.ts's
// own precedent). Not *.test.ts, so vitest does not collect it as its own suite.

import { vi } from 'vitest'
import { createBroker } from '../index.js'
import type { BoundUdpSocket, Broker, CreateBrokerOptions, DialedSocket, ListenedServer } from '../broker-contracts.js'
import type { LedgerStorage, PersistedGrant } from '../grants/ledger-storage.js'
import type { Capabilities, Manifest } from '../../contracts/index.js'

export const APP = 'https://app.example'

/**
 * Spread into a hand-built `CreateBrokerOptions['fs']` literal that only
 * means to exercise readFile/writeFile -- BrokerFs.mkdir/readdir/stat/rm/
 * rename must still exist to satisfy the type, but a test built before
 * queue item 2.1 never calls them, so each one fails loudly rather than
 * silently succeeding if that ever stops being true.
 */
export function unusedFsExtras (): Pick<CreateBrokerOptions['fs'], 'mkdir' | 'readdir' | 'stat' | 'rm' | 'rename'> {
  const notStubbed = (): never => { throw new Error('this stub method was not configured for this test') }
  return {
    mkdir: notStubbed,
    readdir: notStubbed,
    stat: notStubbed,
    rm: notStubbed,
    rename: notStubbed
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
    now: () => 0,
    fs: stubFs(),
    keychain: { getSeed: async () => new Uint8Array(32) },
    ...overrides
  }
}

/** A Map-backed LedgerStorage double -- real behaviour, no disk, matching grant-ledger.test.ts's own local copy of the same idiom. */
export function memoryLedgerStorage (): LedgerStorage & {
  readonly floors: Map<string, string>
  readonly rollbackAcks: Map<string, string>
  readonly grants: Map<string, Readonly<Record<string, PersistedGrant>>>
} {
  const floors = new Map<string, string>()
  const rollbackAcks = new Map<string, string>()
  const grants = new Map<string, Readonly<Record<string, PersistedGrant>>>()
  return {
    floors,
    rollbackAcks,
    grants,
    readVersionFloor: (origin) => floors.get(origin),
    writeVersionFloor: (origin, versionFloor) => { floors.set(origin, versionFloor) },
    deleteVersionFloor: (origin) => { floors.delete(origin) },
    readAcknowledgedRollbackVersion: (origin) => rollbackAcks.get(origin),
    writeAcknowledgedRollbackVersion: (origin, version) => { rollbackAcks.set(origin, version) },
    deleteAcknowledgedRollbackVersion: (origin) => { rollbackAcks.delete(origin) },
    readGrants: (origin) => grants.get(origin),
    writeGrants: (origin, originGrants) => { grants.set(origin, originGrants) },
    deleteGrants: (origin) => { grants.delete(origin) },
    listPersistedOrigins: () => [...grants.keys()]
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
