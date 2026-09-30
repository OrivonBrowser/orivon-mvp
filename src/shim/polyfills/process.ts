// `process` module target (module-map.ts): the process global itself, as
// Node's `require('process') === process`. The function members are named
// exports that forward to the global at call time, so a process the runtime
// or the app has patched answers; the data members are the objects the global
// holds when this module loads, which the runtime has set up by then.

type Call = (...args: unknown[]) => unknown
const current = (): Record<string, Call> => globalThis.process as unknown as Record<string, Call>
const forward = (name: string): Call => (...args) => current()[name]!(...args)

const proc = globalThis.process

export const { env, argv, execArgv, platform, version, versions, pid, ppid, title, arch, release, stdout, stderr } = proc

export const nextTick = forward('nextTick')
export const emitWarning = forward('emitWarning')
export const cwd = forward('cwd')
export const uptime = forward('uptime')
export const memoryUsage = forward('memoryUsage')
export const umask = forward('umask')
export const exit = forward('exit')
export const on = forward('on')
export const addListener = forward('addListener')
export const once = forward('once')
export const off = forward('off')
export const removeListener = forward('removeListener')
export const removeAllListeners = forward('removeAllListeners')
export const emit = forward('emit')
export const listeners = forward('listeners')
export const listenerCount = forward('listenerCount')
export const hrtime = Object.assign(forward('hrtime'), { bigint: () => (current().hrtime as unknown as { bigint: () => bigint }).bigint() })

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/process.js'

export default proc
