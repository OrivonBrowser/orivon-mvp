// The shape each preview1 function family hands host.ts. A function that
// never needs to wait is a plain `sync` function; one that may is an `ops`
// generator of effects (../effects.ts), which host.ts runs under the
// asynchronous driver for a program and the synchronous one for an addon.

import type { Op } from '../effects.js'

/** i32 arguments arrive as numbers, i64 as bigints; the result is an errno. */
export type WasiFunction = (...args: never[]) => number | Promise<number>

export interface ImportFamily {
  readonly sync: Readonly<Record<string, (...args: never[]) => number>>
  readonly ops: Readonly<Record<string, (...args: never[]) => Op<number>>>
}

/** A sink that has taken the bytes by the time it returns. */
export type SyncSink = (bytes: Uint8Array) => void
