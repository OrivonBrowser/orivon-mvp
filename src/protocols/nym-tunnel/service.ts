// The Nym tunnel host's work, apart from the process it runs in: the globals the module needs, the module loaded
// from its pinned files, the tunnels per user name, and the SOCKS5 server in front of them. entry.ts gives this the
// parent port; a test gives it a directory and a recorder.

import { randomBytes } from 'node:crypto'
import { createInstances, DEFAULT_IDLE_MS, DEFAULT_START_WAIT_MS } from './instances.js'
import type { Instances } from './instances.js'
import { loadNymModule } from './module-loader.js'
import type { LoaderSeams } from './module-loader.js'
import { createModuleNetwork } from './module-net.js'
import type { ModuleNetwork } from './module-net.js'
import { failure } from './protocol.js'
import type { FromHost, NymTunnelConfig } from './protocol.js'
import { PinMismatch } from '../local-node/pinned-file.js'
import { startSocksServer } from './socks-server.js'
import type { SocksServer } from './socks-server.js'

export interface HostDeps {
  readonly post: (message: FromHost) => void
  readonly loader?: LoaderSeams
  /** Makes this process what the module needs; the default installs the globals below on this process and quiets its console unless `log`. */
  readonly prepare?: () => Promise<void>
  /** Leaves the module's own log lines in this process's output. */
  readonly log?: boolean
  readonly idleMs?: number
  readonly startWaitMs?: number
}

export interface RunningHost {
  readonly instances: Instances
  readonly server: SocksServer
  stop: () => Promise<void>
}

/** The globals the module reads, which a utility process lacks: `self`, a `WorkerGlobalScope`, an in-memory IndexedDB, and the checked network. */
export async function installModuleGlobals (target: typeof globalThis, network: ModuleNetwork): Promise<void> {
  // IndexedDB in memory: nothing the module keeps (its keys, its gateway registration) outlives this process.
  await import('fake-indexeddb/auto')
  const scope = target as typeof globalThis & { self: unknown, WorkerGlobalScope?: unknown }
  scope.self = target
  if (scope.WorkerGlobalScope === undefined) {
    class WorkerGlobalScope {}
    scope.WorkerGlobalScope = WorkerGlobalScope
    Object.setPrototypeOf(target, WorkerGlobalScope.prototype)
  }
  target.fetch = network.fetch
  target.WebSocket = network.WebSocket
}

/** This process as the module needs it. The module prints its progress through console.log; the output stays quiet unless asked. */
async function prepareProcess (log: boolean): Promise<void> {
  if (!log) {
    console.log = () => {}
    console.info = () => {}
    console.debug = () => {}
  }
  await installModuleGlobals(globalThis, createModuleNetwork())
}

export async function startHost (config: NymTunnelConfig, deps: HostDeps): Promise<RunningHost> {
  const { post } = deps
  await (deps.prepare ?? (async () => { await prepareProcess(deps.log === true) }))()
  let module
  try {
    module = await loadNymModule(config.moduleDir, config.files, deps.loader)
  } catch (error) {
    post(failure(error instanceof PinMismatch ? 'artifact' : 'load', error instanceof Error ? error.message : String(error)))
    throw error
  }

  const instances = createInstances({
    cap: config.maxInstances,
    startWaitMs: deps.startWaitMs ?? DEFAULT_START_WAIT_MS,
    idleMs: deps.idleMs ?? DEFAULT_IDLE_MS,
    start: async (id) => await module.start(`${id}-${randomBytes(6).toString('hex')}`),
    onChange: (snapshot) => { post({ type: 'instances', ...snapshot }) }
  })
  let server: SocksServer
  try {
    server = await startSocksServer(config.port, {
      secret: config.secret,
      acquire: async (name) => await instances.acquire(name)
    })
  } catch (error) {
    post(failure('listen', `could not listen on port ${String(config.port)}: ${error instanceof Error ? error.message : String(error)}`))
    throw error
  }
  post({ type: 'listening' })
  return {
    instances,
    server,
    stop: async () => {
      await server.close()
      await instances.closeAll()
    }
  }
}
