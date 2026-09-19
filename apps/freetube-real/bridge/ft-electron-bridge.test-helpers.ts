// Shared harness for ft-electron-bridge.test.ts and
// ft-electron-bridge-db.test.ts -- code-guidelines.md's own test-helpers
// convention (Rule 2's background section), extracted so the db group's
// tests do not carry a second copy of "run the bridge's classic script in a
// fresh vm context".
import vm from 'node:vm'
import { buildBridgeSource } from './splice-bridge-source.mjs'

const SOURCE = buildBridgeSource()

export interface FakeDocument {
  title: string
  documentElement: { style: Record<string, string>, requestFullscreen: () => Promise<void> }
  querySelector: (selector: string) => { requestPictureInPicture: () => Promise<void> } | null
}

export interface Sandbox {
  window: { orivon?: Record<string, unknown> }
  document: FakeDocument
  // Set by a db-group test AFTER freshBridge() returns, never by load()
  // itself -- datastore() (ft-electron-bridge-db.js) reads this unprefixed
  // `globalThis.__orivonFtDatastore`, and inside a vm context created by
  // `vm.createContext(sandbox)`, `globalThis` IS this sandbox object, not
  // the real outer Node process's.
  __orivonFtDatastore?: unknown
  navigator: { language: string, wakeLock?: { request: (kind: string) => Promise<{ release: () => Promise<void> }> } }
  fetch: (input: string) => Promise<{ ok: boolean, status: number, text: () => Promise<string> }>
  // generatePoToken's own per-attempt deadline (attemptMintOnce) needs real
  // globals here -- a `vm` context gets V8's own built-ins (Promise, Symbol,
  // ...) for free, but NOT Node's globals, `setTimeout`/`clearTimeout`
  // included. Forwarding to the OUTER `globalThis` rather than binding the
  // function values once means these keep working after a test calls
  // `vi.useFakeTimers()`, which replaces what `globalThis.setTimeout` points
  // to -- a value captured before that call would still be the real one.
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  __ftElectronBridgeInternals?: {
    installFtElectronBridge: (getOrivon: () => Record<string, unknown> | undefined) => { bridge: Record<string, any>, recordedListeners: Record<string, unknown> }
    FtBridgeError: new (member: string, reason: string, detail?: string) => Error & { member: string, reason: string }
    rewriteBotGuardScript: (script: string, videoId: string, context: string, attestation: string, ytConfig: string) => string
    PoTokenMintStalledError: new (attempts: number) => Error & { attempts: number }
    MINT_ATTEMPT_DEADLINE_MS: number
    MINT_MAX_ATTEMPTS: number
    DBActions: Record<string, Record<string, number>>
  }
}

export function fakeDocument (overrides: Partial<FakeDocument> = {}): FakeDocument {
  return {
    title: 'FreeTube',
    documentElement: { style: {}, requestFullscreen: async () => {} },
    querySelector: () => null,
    ...overrides
  }
}

/** Runs the bridge's own (spliced) source in a fresh realm, so each test starts from a clean window.ftElectron with no state left over from another test. */
export function load (opts: { orivon?: Record<string, unknown>, document?: Partial<FakeDocument>, navigator?: Partial<Sandbox['navigator']>, fetch?: Sandbox['fetch'] } = {}): Sandbox {
  const sandbox = {
    window: { orivon: opts.orivon },
    document: fakeDocument(opts.document),
    navigator: { language: 'en-US', ...opts.navigator },
    fetch: opts.fetch ?? (async () => { throw new Error('fetch not stubbed for this test') }),
    setTimeout: ((...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args)) as typeof setTimeout,
    clearTimeout: ((...args: Parameters<typeof clearTimeout>) => { globalThis.clearTimeout(...args) }) as typeof clearTimeout
  } as Sandbox
  vm.createContext(sandbox as unknown as object)
  vm.runInContext(SOURCE, sandbox as unknown as object, { filename: 'ft-electron-bridge.js' })
  return sandbox
}

export function internals (sandbox: Sandbox): NonNullable<Sandbox['__ftElectronBridgeInternals']> {
  const found = sandbox.__ftElectronBridgeInternals
  if (found === undefined) throw new Error('bridge did not expose __ftElectronBridgeInternals')
  return found
}

export function freshBridge (opts: Parameters<typeof load>[0] = {}) {
  const sandbox = load(opts)
  return { sandbox, ...internals(sandbox).installFtElectronBridge(() => sandbox.window.orivon) }
}
