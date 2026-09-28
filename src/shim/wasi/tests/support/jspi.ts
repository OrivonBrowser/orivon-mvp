// A WebAssembly namespace with JSPI, for the tests that run real modules.
// Node puts JSPI behind a V8 flag; set at runtime, the flag reaches only
// contexts created after it, so the namespace comes from a fresh vm context.
// On a Node whose V8 lacks the flag the namespace has no Suspending, and
// `hasJspi` lets those tests skip rather than fail.

import v8 from 'node:v8'
import vm from 'node:vm'

v8.setFlagsFromString('--experimental-wasm-jspi')

export const jspiWebAssembly = vm.runInContext('WebAssembly', vm.createContext({})) as typeof WebAssembly

export const hasJspi = typeof (jspiWebAssembly as unknown as { Suspending?: unknown }).Suspending === 'function'
