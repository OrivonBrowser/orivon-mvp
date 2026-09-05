// Shared fixtures for index.test.ts and its siblings (split out under
// code-guidelines.md's 800-line test limit, following handles.test-helpers.ts's
// own precedent). Not *.test.ts, so vitest does not collect it as its own suite.

import { vi } from 'vitest'
import { createBroker } from './index.js'
import type { Broker, CreateBrokerOptions, DialedSocket } from './broker-contracts.js'
import type { LedgerStorage } from './ledger-storage.js'
import type { Capabilities, Manifest } from '../contracts/index.js'

export const APP = 'https://app.example'

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

export function stubFs (options: { root?: string, files?: Map<string, Uint8Array> } = {}): CreateBrokerOptions['fs'] {
  const root = options.root ?? '/apps/app'
  const files = options.files ?? new Map<string, Uint8Array>()
  return {
    rootFor: () => root,
    // Everything "exists" and resolves to itself. Confinement's own edge
    // cases (symlink escapes, Windows device names, ..) are policy/paths.ts's
    // suite; this file only has to prove createBroker calls it.
    realpathSync: (p) => p,
    readFile: async (path) => {
      const data = files.get(path)
      if (data === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return data
    },
    writeFile: async (path, data) => { files.set(path, data) }
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
    resolve: async () => [],
    now: () => 0,
    fs: stubFs(),
    keychain: { getSeed: async () => new Uint8Array(32) },
    ...overrides
  }
}

/** A Map-backed LedgerStorage double -- real behaviour, no disk, matching grant-ledger.test.ts's own local copy of the same idiom. */
export function memoryLedgerStorage (): LedgerStorage & { readonly floors: Map<string, string>, readonly rollbackAcks: Map<string, string> } {
  const floors = new Map<string, string>()
  const rollbackAcks = new Map<string, string>()
  return {
    floors,
    rollbackAcks,
    readVersionFloor: (origin) => floors.get(origin),
    writeVersionFloor: (origin, versionFloor) => { floors.set(origin, versionFloor) },
    deleteVersionFloor: (origin) => { floors.delete(origin) },
    readAcknowledgedRollbackVersion: (origin) => rollbackAcks.get(origin),
    writeAcknowledgedRollbackVersion: (origin, version) => { rollbackAcks.set(origin, version) },
    deleteAcknowledgedRollbackVersion: (origin) => { rollbackAcks.delete(origin) }
  }
}

/** A broker with `APP` registered and granted `tcp.connect` for one address -- the setup every net.connect/fail test below needs. */
export async function brokerWithConnectGrant (deps: Partial<CreateBrokerOptions> = {}): Promise<Broker> {
  const broker = createBroker(baseDeps(deps))
  broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
  await broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])
  return broker
}
