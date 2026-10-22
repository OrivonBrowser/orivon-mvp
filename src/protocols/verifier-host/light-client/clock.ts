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
const PROBE_TIMEOUT_MS = 8_000

export interface ClockReading {
  /** The server's `Date` header, in ms since the epoch. */
  readonly serverMs: number
  /** The local clock when the request left and when its answer arrived. */
  readonly sentAt: number
  readonly receivedAt: number
}

/**
 * How far the local clock is behind the servers, in ms, or `undefined` when
 * it is not behind, or when the readings cannot be trusted as one answer:
 * fewer than two servers, servers that disagree, or a lead no mistake in a
 * clock would explain. The median of several servers, never one server's word.
 */
export function clockLead (readings: readonly ClockReading[]): number | undefined {
  if (readings.length < 2) return undefined
  // A `Date` header counts whole seconds, so the server's real time is half a second past it; the answer was made halfway through the round trip.
  const leads = readings.map((r) => r.serverMs + 500 - (r.sentAt + r.receivedAt) / 2).sort((a, b) => a - b)
  if (leads[leads.length - 1]! - leads[0]! > MAX_SPREAD_MS) return undefined
  const median = leads.length % 2 === 1 ? leads[(leads.length - 1) / 2]! : (leads[leads.length / 2 - 1]! + leads[leads.length / 2]!) / 2
  if (median < MIN_LEAD_MS || median > MAX_LEAD_MS) return undefined
  return Math.round(median)
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

/** The origins asked, each once: the consensus server and every execution RPC. */
export async function measureClockLead (servers: readonly string[], fetch: WebFetch, now: () => number = Date.now): Promise<number | undefined> {
  const origins = [...new Set(servers.map((server) => new URL(server).origin))]
  const readings = await Promise.all(origins.map(async (origin) => await readClock(`${origin}/`, fetch, now)))
  return clockLead(readings.filter((reading): reading is ClockReading => reading !== undefined))
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

/** Raises the lead so Helios's clock is at least at a block the chain proved (`blockMs`): a verified header is a floor on the real time. Never lowers it. */
export function raiseHeliosClockToBlock (blockMs: number): void {
  const needed = blockMs - trueNow()
  if (needed >= MIN_LEAD_MS && needed > lead && needed <= MAX_LEAD_MS) lead = Math.round(needed)
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
    Error.stackTraceLimit = 4
    const stack = new Error().stack ?? ''
    Error.stackTraceLimit = limit
    return HELIOS_FRAME.test(stack) ? real + lead : real
  }
  Date.now = wrapper
}

/** The wall clock and the monotonic one, as `clockJumped` last saw them. */
let seenWall = 0
let seenMonotonic = 0
const JUMP_MS = 5_000

/**
 * Whether the system clock was set since the last call (the person fixed it,
 * or the computer woke up and the network time arrived): the wall clock moved
 * by more than the monotonic one did. A lead measured before that is wrong.
 */
export function clockJumped (): boolean {
  const wall = trueNow()
  const monotonic = performance.now()
  const jumped = seenWall !== 0 && Math.abs((wall - seenWall) - (monotonic - seenMonotonic)) > JUMP_MS
  seenWall = wall
  seenMonotonic = monotonic
  return jumped
}

/** Test seam: back to a process nothing has touched. */
export function resetHeliosClock (): void {
  if (wrapper !== undefined && original !== undefined && Date.now === wrapper) Date.now = original
  wrapper = undefined
  original = undefined
  lead = 0
  seenWall = 0
}
