// `console` module target (module-map.ts): the global console itself, as
// Node's `require('console') === console`. Each named export forwards to the
// global at call time, so a console the runtime or the app has since patched
// is the one that answers. `Console` (a console over given streams) refuses
// by name.

type ConsoleMethod = (...args: unknown[]) => void

function forward (name: string): ConsoleMethod {
  return (...args) => { (globalThis.console as unknown as Record<string, ConsoleMethod>)[name]!(...args) }
}

export const log = forward('log')
export const info = forward('info')
export const warn = forward('warn')
export const error = forward('error')
export const debug = forward('debug')
export const trace = forward('trace')
export const dir = forward('dir')
export const dirxml = forward('dirxml')
export const table = forward('table')
export const assert = forward('assert')
export const count = forward('count')
export const countReset = forward('countReset')
export const group = forward('group')
export const groupCollapsed = forward('groupCollapsed')
export const groupEnd = forward('groupEnd')
export const time = forward('time')
export const timeEnd = forward('timeEnd')
export const timeLog = forward('timeLog')
export const clear = forward('clear')

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/console.js'

export default globalThis.console
