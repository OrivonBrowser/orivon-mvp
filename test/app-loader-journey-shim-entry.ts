// Bundled with esbuild (platform: 'browser') by
// ./e2e-app-loader-journey.test.ts into the fixture app's own served
// script -- see that file's header for what this proves and what it stands
// in for.
//
// IMPORTS src/shim/node-net.ts BY RELATIVE PATH, not via the bare 'net'
// specifier module-map.ts's alias table points a real app's own bundler at.
// This repository has no bundler step for an EXTERNAL app's own code --
// that aliasing (electron.vite.config.ts's `renderer.resolve.alias`,
// generated from module-map.ts) is scoped to this repo's own chrome UI
// (src/renderer/), not to a page an app loader serves from a foreign
// origin. So there is no real `require('net')` resolution step to
// reproduce here. What this file DOES exercise for real is the exact
// module that alias points at -- the genuine, unmodified orivon-node-shim
// `net` implementation (src/shim/node-net.ts, src/shim/node-net-socket.ts),
// run inside a real browser page, driven exactly the way an ordinary
// Node TCP client library drives `require('net')`: `connect(opts, cb)`,
// `.write()`/`.end()`, `.on('data'/'end'/'error')` -- never the raw
// `orivon.net.connect()` WHATWG-stream API the shim itself calls into
// (src/shim/orivon-global.ts's `getOrivon()` is the ONLY place that
// happens, inside the imported module, not here).

import { installGlobals } from '../src/shim/globals.js'
import type { GlobalsTarget } from '../src/shim/globals.js'
import { connect } from '../src/shim/node-net.js'

// FOUND WRITING THIS FIXTURE, FILED AS A151 (docs/open-questions.md):
// installGlobals() (this same file) has NO production call site anywhere in
// src/ -- nothing installs `process`/`setImmediate`/`clearImmediate` onto a
// real app tab's globalThis today. stream-browserify's own `Readable.resume`
// reads `process.nextTick` unconditionally, so ANY real app requiring a Node
// library that pulls in `stream` (this shim's own 'net' does, via
// node-net-socket.ts's `Duplex`) would hit the identical `ReferenceError:
// process is not defined` this fixture hit before the line below was added.
// Installed here, onto the real globalThis, exactly once -- the same call a
// real production entry point will need, wherever build step 3's own work
// ends up wiring it.
// Cast, not a structural match: this repo's tsconfig sets `"types":
// ["node"]` globally, so `globalThis.process` is typed as Node's real
// `Process` (no `browser` field) rather than `GlobalsTarget`'s `ShimProcess`
// -- the sandboxed renderer this shim actually runs in has no such global to
// conflict with; only this file's own type-checking environment does.
installGlobals(globalThis as unknown as GlobalsTarget, {
  reportError: (error, origin) => { console.error(`[orivon-shim:${origin}]`, error) }
})

/** Matches src/shim/node-http-errors.ts's NodeShapedError -- the shape a
 * denial or connect failure actually arrives in through this shim, not the
 * raw OrivonError src/contracts/errors.ts declares. Read only for this
 * probe's own reporting. */
interface ShimSocketError extends Error {
  readonly code: string
  readonly orivonCode: string
}

export interface ShimRoundTripResult {
  readonly sent: string
  readonly received: string
}

export interface ShimRoundTripFailure {
  readonly rejected: true
  readonly name: string
  readonly code: string
  readonly orivonCode: string
  readonly message: string
}

/**
 * One full round trip through the real shim `net` module: connect, write
 * `message`, half-close this side, then read until the peer's own FIN --
 * the fixture echo server carries no framing, so EOF is the only way to
 * know the reply is complete (same reasoning as apps/fixture/app.js's own
 * roundTrip()). Resolves on success; on a denial or a real connect failure,
 * resolves to a plain, structurally-typed failure object instead of
 * rejecting, because this function is called from `page.evaluate()` and a
 * rejected evaluate() throws on the TEST side with no chance to inspect the
 * shape of what failed (E-F3's reasoning in test/e2e-capability-boundary.
 * test.ts applies here too: capture the outcome, don't let it vanish into a
 * generic evaluate() rejection).
 */
function shimRoundTrip (host: string, port: number, message: string): Promise<ShimRoundTripResult | ShimRoundTripFailure> {
  return new Promise((resolve) => {
    const socket = connect({ host, port }, () => {
      socket.end(new TextEncoder().encode(message))
    })
    const chunks: Uint8Array[] = []
    socket.on('data', (chunk: Uint8Array) => { chunks.push(chunk) })
    socket.on('end', () => {
      const total = chunks.reduce((n, c) => n + c.length, 0)
      const out = new Uint8Array(total)
      let offset = 0
      for (const c of chunks) { out.set(c, offset); offset += c.length }
      resolve({ sent: message, received: new TextDecoder().decode(out) })
    })
    socket.once('error', (error: unknown) => {
      const shaped = error as Partial<ShimSocketError>
      resolve({
        rejected: true,
        name: shaped.name ?? 'Error',
        code: shaped.code ?? '',
        orivonCode: shaped.orivonCode ?? '',
        message: shaped.message ?? String(error)
      })
    })
  })
}

declare global {
  // `var`, not `let`/`const`: TypeScript requires it for a `declare global`
  // augmentation (same convention as src/main/dev-grant.ts's own hook).
  var __orivonShimRoundTrip: ((host: string, port: number, message: string) => Promise<ShimRoundTripResult | ShimRoundTripFailure>) | undefined
}

// Exposed on window rather than auto-run on load: the test drives this at
// its own pace (before a grant exists, after one, then against an
// out-of-manifest port), and calling an already-present global function is
// exactly how the rest of this suite's fixtures already work
// (window.orivon.net.connect itself is called the same way, never
// auto-invoked by the page it is exposed on).
globalThis.__orivonShimRoundTrip = shimRoundTrip
