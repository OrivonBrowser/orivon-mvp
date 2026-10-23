// A computer whose clock runs behind the chain cannot start Helios: it refuses
// any update signed in a slot the local clock has not reached yet. This file
// measures how far behind the clock is, from the `Date` header of the servers
// the light client already talks to, and lends that lead to Helios alone.
// Nothing here weakens a proof: the clock only decides what is too new to
// accept, and a wrong clock cannot make Helios accept a forged header. The
// worst a lie does is hand it older, validly signed data, as a stale server can.

import type { WebFetch } from '../egress.js'

/** Wall-clock time-zone mistakes are the common cause, and reach 14 hours either way. */
export const MAX_LEAD_MS = 24 * 60 * 60_000
/** Below this the clock is as right as a `Date` header can tell (it counts whole seconds). */
const MIN_LEAD_MS = 2_000
/** Servers whose clocks differ by more than this from each other are not a reference for anything. */
const MAX_SPREAD_MS = 30_000
/** Long enough for a tunnel's first request, which is slow to open. */
const PROBE_TIMEOUT_MS = 15_000

export interface ClockReading {
  /** The server's `Date` header, in ms since the epoch. */
  readonly serverMs: number
  /** The local clock when the request left and when its answer arrived. */
  readonly sentAt: number
  readonly receivedAt: number
}

/**
 * How far the local clock is behind the servers, in ms: 0 when they say it is
 * not, `undefined` when they cannot be taken as one answer (too few, or no
 * majority of the `asked` servers agreeing within 30 s, or a lead no mistake
 * in a clock would explain). The middle of the largest group that agrees,
 * never one server's word, and a server that is off by itself is left out.
 * `asked` counts the servers that were asked, not only those that answered,
 * so a few answers from servers of one operator cannot decide.
 */
export function clockLead (readings: readonly ClockReading[], asked: number = readings.length): number | undefined {
  if (readings.length < 2) return undefined
  // A `Date` header counts whole seconds, so the server's real time is half a second past it; the answer was made halfway through the round trip.
  const leads = readings.map((r) => r.serverMs + 500 - (r.sentAt + r.receivedAt) / 2).sort((a, b) => a - b)
  let group: number[] = []
  for (let from = 0; from < leads.length; from++) {
    const inside = leads.slice(from).filter((lead) => lead - leads[from]! <= MAX_SPREAD_MS)
    if (inside.length > group.length) group = inside
  }
  if (group.length < 2 || group.length * 2 <= asked) return undefined
  const median = group.length % 2 === 1 ? group[(group.length - 1) / 2]! : (group[group.length / 2 - 1]! + group[group.length / 2]!) / 2
  if (median > MAX_LEAD_MS) return undefined
  return median < MIN_LEAD_MS ? 0 : Math.round(median)
}

/** One `Date` header read from `url`'s server, through the light client's own allowlisted fetch. */
async function readClock (url: string, fetch: WebFetch, now: () => number): Promise<ClockReading | undefined> {
  const sentAt = now()
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    const receivedAt = now()
    const header = response.headers.get('date')
    await response.body?.cancel().catch(() => {})
    const serverMs = header === null ? Number.NaN : Date.parse(header)
    return Number.isFinite(serverMs) ? { serverMs, sentAt, receivedAt } : undefined
  } catch {
    return undefined
  }
}

/** The origins asked, each once: the consensus server and every execution RPC. See `clockLead` for what comes back. */
export async function measureClockLead (servers: readonly string[], fetch: WebFetch, now: () => number = Date.now): Promise<number | undefined> {
  const origins = [...new Set(servers.map((server) => new URL(server).origin))]
  const readings = await Promise.all(origins.map(async (origin) => await readClock(`${origin}/`, fetch, now)))
  return clockLead(readings.filter((reading): reading is ClockReading => reading !== undefined), origins.length)
}

/** Where Helios's own frames show in a stack: its WebAssembly glue reads the time from there. */
const HELIOS_FRAME = /[\\/]@a16z[\\/]helios[\\/]/

let lead = 0
/** What `Date.now` was before this file wrapped it, and the wrapper that replaced it. */
let original: (() => number) | undefined
let wrapper: (() => number) | undefined

function trueNow (): number {
  return original === undefined ? Date.now() : original.call(Date)
}

/** The lead Helios's clock has now, in ms; 0 is no correction. */
export function heliosClockLead (): number {
  return lead
}

/** A lead is set, never added to: the next measurement replaces it. A negative or non-finite one is ignored. */
export function setHeliosClockLead (ms: number): void {
  lead = Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), MAX_LEAD_MS) : 0
}

/**
 * Makes `Date.now()` answer with the lead added when Helios asks, and the true time
 * to every other caller of this process (certificates, cache lifetimes, retry
 * times). Helios is told apart by its own frame in the stack; with no lead set
 * the stack is never read, so a computer with a right clock pays nothing.
 * Safe to call again: it wraps `Date.now` once, and again if something replaced it.
 */
export function installHeliosClock (): void {
  if (wrapper !== undefined && Date.now === wrapper) return
  const before = Date.now
  original = before
  wrapper = function now (): number {
    const real = before.call(Date)
    if (lead === 0) return real
    const limit = Error.stackTraceLimit
    let stack: string
    try {
      Error.stackTraceLimit = 4
      stack = new Error().stack ?? ''
    } finally {
      Error.stackTraceLimit = limit
    }
    return HELIOS_FRAME.test(stack) ? real + lead : real
  }
  Date.now = wrapper
}

/** The wall clock and the monotonic one, as `clockJump` last saw them. */
let seenWall = 0
let seenMonotonic = 0
const JUMP_MS = 5_000

/**
 * How far the system clock was set since the last call, in ms: the wall clock
 * moved by more than the monotonic one did. Negative when it was set back,
 * positive when it was set forward or the computer woke up (the monotonic
 * clock stops while it sleeps). 0 on the first call and within a few seconds.
 */
export function clockJump (): number {
  const wall = trueNow()
  const monotonic = performance.now()
  const jump = seenWall === 0 ? 0 : (wall - seenWall) - (monotonic - seenMonotonic)
  seenWall = wall
  seenMonotonic = monotonic
  return Math.abs(jump) > JUMP_MS ? Math.round(jump) : 0
}

/** Test seam: back to a process nothing has touched. */
export function resetHeliosClock (): void {
  if (wrapper !== undefined && original !== undefined && Date.now === wrapper) Date.now = original
  wrapper = undefined
  original = undefined
  lead = 0
  seenWall = 0
}
