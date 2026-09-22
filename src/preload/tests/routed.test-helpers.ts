// Shared fixtures for the routed-network suites (fetch, XHR, EventSource).
// Not *.test.ts, so vitest does not collect it as its own suite.
//
// Every installer is RE-EVALUATED from its own source text before use, the
// way contextBridge.executeInMainWorld runs it in a page: a reference to
// anything outside the function's body -- an import, a module-level const
// -- throws a ReferenceError here exactly as it would in the main world.
import { installRoutedWire } from '../routed-wire.js'
import { installRoutedDial } from '../routed-dial.js'
import { installRoutedCore, releaseRoutedSlot } from '../routed-core.js'
import { installFetchRoute } from '../fetch-route.js'
import type { FetchRouteSocket, FetchRouteTarget } from '../fetch-route-types.js'

type Installer = (isAppTab: boolean, target?: FetchRouteTarget) => void

/** A function rebuilt from its own source text alone, in this realm's global scope. */
export function reserialised<T> (fn: T): T {
  return new Function(`return (${String(fn)})`)() as T // eslint-disable-line no-new-func
}

export const NETWORK_INSTALLERS: readonly Installer[] = [installRoutedWire, installRoutedDial, installRoutedCore, installFetchRoute].map((fn) => reserialised(fn as Installer))

/** Installs the routed path on `target` in production order, then removes the shared slot. */
export function installRouted (target: FetchRouteTarget, extra: readonly Installer[] = []): void {
  for (const install of [...NETWORK_INSTALLERS, ...extra]) install(true, target)
  reserialised(releaseRoutedSlot)(target)
}

export function bytes (text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function concat (...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}

export interface FakeSocket extends FetchRouteSocket {
  readonly written: Uint8Array[]
  readonly closed: boolean
  /** Everything written so far, as text. */
  readonly sent: string
  /** Pushes more bytes from the "peer"; `end()` closes its side. */
  push: (chunk: Uint8Array) => void
  end: () => void
}

/**
 * A fake TcpSocket. `chunks` are what the peer sends back straight away; with
 * `hold`, the readable stays open for `push`/`end` instead of closing.
 */
export function fakeSocket (chunks: Uint8Array[], hold = false): FakeSocket {
  const state = { written: [] as Uint8Array[], closed: false }
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
  const readable = new ReadableStream<Uint8Array>({
    start (controller) {
      controllerRef = controller
      for (const chunk of chunks) controller.enqueue(chunk)
      if (!hold) controller.close()
    }
  })
  const writable = new WritableStream<Uint8Array>({ write (chunk) { state.written.push(chunk) } })
  return {
    readable,
    writable,
    close: async () => {
      state.closed = true
      try { controllerRef?.close() } catch { /* already closed */ }
    },
    get written () { return state.written },
    get closed () { return state.closed },
    get sent () { return state.written.map((c) => new TextDecoder().decode(c)).join('') },
    push: (chunk) => { controllerRef?.enqueue(chunk) },
    end: () => { try { controllerRef?.close() } catch { /* already closed */ } }
  }
}

/** A plain `orivon.net`-bearing target for installers to run against. */
export function fakeTarget (opts: {
  connect?: (o: { host: string, port: number }) => Promise<FetchRouteSocket>
  connectSecure?: (o: { host: string, port: number }) => Promise<FetchRouteSocket>
  location?: { origin: string, href: string }
  nativeFetch?: (input: unknown, init?: unknown) => Promise<Response>
  userAgent?: string
}): FetchRouteTarget {
  const target: FetchRouteTarget = {
    orivon: {
      net: {
        connect: opts.connect ?? (async () => { throw new Error('unexpected net.connect call') }),
        connectSecure: opts.connectSecure ?? (async () => { throw new Error('unexpected net.connectSecure call') })
      }
    }
  }
  if (opts.location !== undefined) target.location = opts.location
  if (opts.nativeFetch !== undefined) target.fetch = opts.nativeFetch
  if (opts.userAgent !== undefined) target.navigator = { userAgent: opts.userAgent }
  return target
}

/** An OrivonError-shaped refusal, as `orivon.net` rejects with one. */
export function refusal (code: string): Error {
  return Object.assign(new Error(`orivon: ${code}`), { code })
}

export const OK_RESPONSE = bytes('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Type: text/plain\r\n\r\nhello')

/** Lets every queued microtask and zero-delay timer run. */
export async function settle (): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
