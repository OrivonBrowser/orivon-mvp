// Node globals that webtorrent's dependency graph expects to exist.
//
// A sandboxed renderer has no `process` and no `global`, and several packages
// (debug, and webtorrent's own feature detection) read them at MODULE
// EVALUATION time -- so this must run before anything else is imported.
// renderer.js imports it first for that reason; ESM executes imports in order.
//
// This is a real requirement of the production design too, not a spike
// artefact: the app bundle always runs in a sandboxed renderer.
import processPolyfill from 'process'
import { Buffer } from 'buffer'

if (globalThis.process === undefined) globalThis.process = processPolyfill
if (globalThis.global === undefined) globalThis.global = globalThis
if (globalThis.Buffer === undefined) globalThis.Buffer = Buffer

// `debug` reads these; without them it throws rather than simply staying quiet.
if (globalThis.process.env === undefined) globalThis.process.env = {}
if (typeof globalThis.process.nextTick !== 'function') {
  globalThis.process.nextTick = (fn, ...args) => queueMicrotask(() => fn(...args))
}

export {}
