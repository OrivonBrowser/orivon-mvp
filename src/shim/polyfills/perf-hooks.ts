// `perf_hooks` module target (module-map.ts): the platform's own
// `performance` and its entry classes, read from the global at load. The
// event-loop histograms Node adds have no page equivalent and refuse.

import { nodeModule } from './module-proxy.js'

export const performance = globalThis.performance
export const PerformanceObserver = globalThis.PerformanceObserver
export const PerformanceEntry = globalThis.PerformanceEntry
export const PerformanceMark = globalThis.PerformanceMark
export const PerformanceMeasure = globalThis.PerformanceMeasure

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/perf-hooks.js'

export default nodeModule('perf_hooks', { performance, PerformanceObserver, PerformanceEntry, PerformanceMark, PerformanceMeasure })
