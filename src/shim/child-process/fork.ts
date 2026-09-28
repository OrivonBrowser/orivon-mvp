// `fork`: an app module, bundled for the browser like the rest of the app,
// run in a Worker with Node's process around it and an IPC channel to its
// parent. It reaches orivon.* through the page, as the page does.

import { refuseShim } from '../errors.js'
import { codedError } from '../node-errors.js'
import { VIRTUAL_ROOT } from '../virtual-root.js'
import { ChildProcess } from './child.js'
import { type SpawnOptions, applyLifetime, environmentOf, launch, normalizeStdio } from './spawn.js'

export interface ForkOptions extends SpawnOptions {
  readonly execPath?: string
  readonly execArgv?: readonly string[]
  readonly silent?: boolean
  readonly serialization?: 'json' | 'advanced'
}

/** The module's URL on the app's origin, where the app's bundler put it. */
function moduleUrl (modulePath: string | URL, origin: string): string {
  const path = modulePath instanceof URL ? modulePath.pathname : modulePath
  const url = new URL(path.startsWith('/') ? path : `/${path}`, origin)
  if (url.origin !== new URL(origin).origin) {
    throw refuseShim('child_process.fork', 'not-applicable', 'a forked module must come from the app\'s own origin')
  }
  return url.href
}

export function fork (modulePath: string | URL, argsOrOptions?: readonly string[] | ForkOptions, maybeOptions?: ForkOptions): ChildProcess {
  if (typeof modulePath !== 'string' && !(modulePath instanceof URL)) {
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "modulePath" argument must be of type string or an instance of URL. Received ${typeof modulePath}`)
  }
  const args = (Array.isArray(argsOrOptions) ? argsOrOptions as readonly string[] : []).map(String)
  const options: ForkOptions = (Array.isArray(argsOrOptions) || argsOrOptions === undefined || argsOrOptions === null ? maybeOptions : argsOrOptions as ForkOptions) ?? {}
  const execPath = (globalThis as { process?: { execPath?: string } }).process?.execPath
  if (options.execPath !== undefined && options.execPath !== execPath) {
    throw refuseShim('child_process.fork options.execPath', 'not-applicable',
      'execPath names a native program to run the module with; a forked module runs in a Web Worker (ADR-0040)')
  }
  const stdio = options.stdio ?? (options.silent === true ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['inherit', 'inherit', 'inherit', 'ipc'])
  const { modes, ipc } = normalizeStdio(stdio, 'child_process.fork')
  if (!ipc) throw codedError(Error, 'ERR_CHILD_PROCESS_IPC_REQUIRED', 'Forked processes must have an IPC channel, missing value \'ipc\' in options.stdio')
  const origin = globalThis.location.origin
  const url = moduleUrl(modulePath, origin)
  const path = new URL(url).pathname
  const serialization = options.serialization ?? 'json'
  const child = new ChildProcess({ spawnfile: 'node', spawnargs: ['node', ...(options.execArgv ?? []), path, ...args], stdio: modes, ipc: true, serialization })
  applyLifetime(child, options)
  const env = environmentOf(options.env)
  launch(child, `child_process fork ${path}`, (orivon) => ({
    type: 'fork', url, argv: ['node', path, ...args], env, cwd: options.cwd ?? VIRTUAL_ROOT, serialization, orivon
  }))
  return child
}
