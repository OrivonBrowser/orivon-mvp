// Shared fixtures for index.test.ts and its siblings (split out under
// code-guidelines.md's 800-line test limit, following handles.test-helpers.ts's
// own precedent). Not *.test.ts, so vitest does not collect it as its own suite.

import { vi } from 'vitest'
import { createBroker } from './index.js'
import type { Broker, CreateBrokerOptions, DialedSocket } from './index.js'
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

export function baseDeps (overrides: Partial<CreateBrokerOptions> = {}): CreateBrokerOptions {
  return {
    dial: overrides.dial ?? (async () => okSocket()),
    resolve: overrides.resolve ?? (async () => []),
    now: overrides.now ?? (() => 0),
    fs: overrides.fs ?? stubFs(),
    keychain: overrides.keychain ?? { getSeed: async () => new Uint8Array(32) }
  }
}

/** A broker with `APP` registered and granted `tcp.connect` for one address -- the setup every net.connect/fail test below needs. */
export async function brokerWithConnectGrant (deps: Partial<CreateBrokerOptions> = {}): Promise<Broker> {
  const broker = createBroker(baseDeps(deps))
  broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
  await broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])
  return broker
}
