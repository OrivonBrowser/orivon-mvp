// Generated (A287): a named export per Node `process` member this shim does
// not export itself, each throwing the refusal this module's own default export already
// throws for the same name -- so a bundler's CommonJS require() interop, which hands the
// ESM namespace rather than the default, still names the gap instead of `undefined`. An
// explicit export in process.js shadows one of these, so a member this shim later
// builds drops its stand-in on the next regeneration. Do not hand-edit -- regenerate with
// ORIVON_WRITE_SHIM_REFUSALS=1 npx vitest run src/shim/tests/generated-refusals.test.ts

import { refusingExport } from '../../generated-refusal.js'
import { nodeModuleRefusal } from '../module-proxy.js'

const classify = (prop: string) => nodeModuleRefusal('process', prop)

export const _debugEnd = refusingExport('_debugEnd', classify)
export const _debugProcess = refusingExport('_debugProcess', classify)
export const _disconnect = refusingExport('_disconnect', classify)
export const _fatalException = refusingExport('_fatalException', classify)
export const _getActiveHandles = refusingExport('_getActiveHandles', classify)
export const _getActiveRequests = refusingExport('_getActiveRequests', classify)
export const _kill = refusingExport('_kill', classify)
export const _linkedBinding = refusingExport('_linkedBinding', classify)
export const _rawDebug = refusingExport('_rawDebug', classify)
export const _send = refusingExport('_send', classify)
export const _startProfilerIdleNotifier = refusingExport('_startProfilerIdleNotifier', classify)
export const _stopProfilerIdleNotifier = refusingExport('_stopProfilerIdleNotifier', classify)
export const _tickCallback = refusingExport('_tickCallback', classify)
export const abort = refusingExport('abort', classify)
export const availableMemory = refusingExport('availableMemory', classify)
export const binding = refusingExport('binding', classify)
export const chdir = refusingExport('chdir', classify)
export const constrainedMemory = refusingExport('constrainedMemory', classify)
export const cpuUsage = refusingExport('cpuUsage', classify)
export const disconnect = refusingExport('disconnect', classify)
export const dlopen = refusingExport('dlopen', classify)
export const execve = refusingExport('execve', classify)
export const getActiveResourcesInfo = refusingExport('getActiveResourcesInfo', classify)
export const getBuiltinModule = refusingExport('getBuiltinModule', classify)
export const getegid = refusingExport('getegid', classify)
export const geteuid = refusingExport('geteuid', classify)
export const getgid = refusingExport('getgid', classify)
export const getgroups = refusingExport('getgroups', classify)
export const getuid = refusingExport('getuid', classify)
export const hasUncaughtExceptionCaptureCallback = refusingExport('hasUncaughtExceptionCaptureCallback', classify)
export const initgroups = refusingExport('initgroups', classify)
export const kill = refusingExport('kill', classify)
export const loadEnvFile = refusingExport('loadEnvFile', classify)
export const openStdin = refusingExport('openStdin', classify)
export const reallyExit = refusingExport('reallyExit', classify)
export const ref = refusingExport('ref', classify)
export const resourceUsage = refusingExport('resourceUsage', classify)
export const send = refusingExport('send', classify)
export const setSourceMapsEnabled = refusingExport('setSourceMapsEnabled', classify)
export const setUncaughtExceptionCaptureCallback = refusingExport('setUncaughtExceptionCaptureCallback', classify)
export const setegid = refusingExport('setegid', classify)
export const seteuid = refusingExport('seteuid', classify)
export const setgid = refusingExport('setgid', classify)
export const setgroups = refusingExport('setgroups', classify)
export const setuid = refusingExport('setuid', classify)
export const threadCpuUsage = refusingExport('threadCpuUsage', classify)
export const unref = refusingExport('unref', classify)

/**
 * Node `process` members this file has no stand-in for: real Node exposes each
 * as DATA, not a function, and a throwing stand-in would misreport its own type (A169).
 * Checked by the freshness test above, so a member that changes shape is still seen.
 */
export const DATA_GAPS: readonly string[] = ["_events","_eventsCount","_exiting","_handleQueue","_maxListeners","_pendingMessage","_preload_modules","allowedNodeEnvironmentFlags","argv0","channel","config","connected","debugPort","domain","execPath","exitCode","features","finalization","moduleLoadList","report","sourceMapsEnabled","stdin"]
