/**
 * What the two batches cost and when they need money: amounts in PLUR (1 xBZZ = 1e16), time in seconds, a Gnosis block
 * every 5 s. Pure functions: nothing here talks to a node.
 */

export const PLUR_PER_BZZ = 10n ** 16n
export const WEI_PER_XDAI = 10n ** 18n
export const BLOCK_SECONDS = 5
export const DAY = 86_400

/** Raised when an operation would take this run past its spending limit. */
export class SpendCapError extends Error {}
/** Raised when the node's wallet holds too little to do what the run needs. */
export class FundsError extends Error {}

/**
 * The per-chunk amount that keeps a batch alive for `seconds` at the chain's current price.
 * @param {number} seconds
 * @param {bigint} price PLUR per chunk per block
 * @returns {bigint}
 */
export const perChunkFor = (seconds, price) => BigInt(Math.ceil(Math.max(seconds, 0) / BLOCK_SECONDS)) * price

/**
 * What an amount per chunk costs on a batch of `depth`: it is paid for every one of the 2^depth chunks.
 * @param {bigint} perChunk
 * @param {number} depth
 * @returns {bigint}
 */
export const costOf = (perChunk, depth) => perChunk * 2n ** BigInt(depth)

/**
 * The top-up that brings a batch back to its target life, or null while it still has at least `minDays` left.
 * @param {{ ttl: number, depth: number }} batch ttl in seconds (Infinity when the batch never expires)
 * @param {{ minDays: number, targetDays: number }} limits
 * @param {bigint} price
 * @returns {{ perChunk: bigint, cost: bigint, seconds: number } | null}
 */
export function topUpFor ({ ttl, depth }, { minDays, targetDays }, price) {
  if (ttl >= minDays * DAY) return null
  const seconds = targetDays * DAY - Math.max(ttl, 0)
  const perChunk = perChunkFor(seconds, price)
  return { perChunk, cost: costOf(perChunk, depth), seconds }
}

/**
 * Diluting a batch to `depth + steps` divides what each chunk has left by 2^steps.
 * @param {number} ttl
 * @param {number} steps
 * @returns {number}
 */
export const ttlAfterDilution = (ttl, steps) => ttl / 2 ** steps

/**
 * A batch that was bought a moment ago, or changed a moment ago, shows its old numbers until the chain event is read.
 * @param {string | undefined} at an ISO time
 * @param {number} now
 * @param {number} windowMs
 * @returns {boolean}
 */
export const within = (at, now, windowMs) => at !== undefined && now - Date.parse(at) < windowMs

/**
 * What a run has to do to the two batches, from what the node reports of them. `held` is each batch's record in the
 * state (null when none is bought yet), `seen` what the node says of it (null when `held` is null).
 *
 * pointer: bought when missing or gone; diluted by one level at `diluteAt` fill, then topped up if that halved its life
 *   under the minimum; topped up below `minDays`. content: bought when missing or gone; replaced (a rotation) at
 *   `rotateAt` fill; topped up below `minDays`.
 * @param {{ cfg: any, held: { pointer: any, content: any }, seen: { pointer: any, content: any }, price: bigint, now: number }} input
 * @returns {{ op: 'buy' | 'rotate' | 'dilute' | 'topup', role: 'pointer' | 'content', cost: bigint, why: string }[]}
 */
export function planBatches ({ cfg, held, seen, price, now }) {
  /** @type {{ op: 'buy' | 'rotate' | 'dilute' | 'topup', role: 'pointer' | 'content', cost: bigint, why: string }[]} */
  const plan = []
  const buyCost = (/** @type {'pointer' | 'content'} */ role) => costOf(perChunkFor(cfg[role].targetDays * DAY, price), cfg[role].depth)
  for (const role of /** @type {const} */ (['pointer', 'content'])) {
    const record = held[role]
    const stamp = seen[role]
    if (record === null || stamp === null) {
      plan.push({ op: 'buy', role, cost: buyCost(role), why: 'none bought yet' })
      continue
    }
    if (!stamp.found) {
      // A batch bought a moment ago is not in the node's lists until its chain event is read.
      if (!within(record.boughtAt, now, 3 * cfg.waitMs)) plan.push({ op: 'buy', role, cost: buyCost(role), why: `batch ${record.id} is gone (expired or unknown to the node)` })
      continue
    }
    if (!stamp.usable) continue
    const settling = within(record.changedAt, now, cfg.settleMs)
    let { ttl, depth } = stamp
    if (role === 'content' && stamp.fill >= cfg.rotateAt) {
      plan.push({ op: 'rotate', role, cost: buyCost(role), why: `fill ${stamp.fill.toFixed(2)} reached ${String(cfg.rotateAt)}` })
      continue
    }
    if (settling) continue
    if (role === 'pointer' && stamp.fill >= cfg.pointer.diluteAt) {
      plan.push({ op: 'dilute', role, cost: 0n, why: `fill ${stamp.fill.toFixed(2)} reached ${String(cfg.pointer.diluteAt)}` })
      ttl = ttlAfterDilution(ttl, 1)
      depth += 1
    }
    const topUp = topUpFor({ ttl, depth }, cfg[role], price)
    if (topUp !== null) plan.push({ op: 'topup', role, cost: topUp.cost, why: `${(ttl / DAY).toFixed(1)} days left, under ${String(cfg[role].minDays)}` })
  }
  return plan
}

/** The money a run may spend, in PLUR. */
export class SpendBudget {
  /** @param {bigint} cap */
  constructor (cap) {
    this.cap = cap
    this.spent = 0n
  }

  /** @param {bigint} cost @returns {boolean} */
  allows (cost) { return this.spent + cost <= this.cap }

  /**
   * Counts `cost` as spent, or refuses it.
   * @param {bigint} cost
   * @param {string} what
   */
  charge (cost, what) {
    if (!this.allows(cost)) throw new SpendCapError(`refusing to ${what}: ${bzz(cost)} would take this run to ${bzz(this.spent + cost)}, over the limit of ${bzz(this.cap)} (MAX_SPEND_BZZ)`)
    this.spent += cost
  }
}

/** @param {bigint} plur @returns {string} xBZZ with four decimals */
export function bzz (plur) {
  const whole = plur / PLUR_PER_BZZ
  const fraction = (plur % PLUR_PER_BZZ) / 10n ** 12n
  return `${String(whole)}.${String(fraction).padStart(4, '0')} xBZZ`
}

/**
 * Refuses a plan the wallet cannot pay for or the limit does not allow, before any of it is carried out, so a run never
 * buys one batch and then fails on the next.
 * @param {{ plan: { cost: bigint, op: string }[], wallet: { address: string, bzz: bigint, xdai: bigint }, budget: SpendBudget, minXdai: bigint }} input
 */
export function checkPlan ({ plan, wallet, budget, minXdai }) {
  if (plan.length === 0) return
  const total = plan.reduce((sum, step) => sum + step.cost, 0n)
  if (!budget.allows(total)) throw new SpendCapError(`refusing this run's batch operations: they cost ${bzz(total)} and the limit is ${bzz(budget.cap)} (MAX_SPEND_BZZ)`)
  if (wallet.bzz < total) throw new FundsError(`the wallet needs ${bzz(total)} and holds ${bzz(wallet.bzz)}: fund ${wallet.address} with xBZZ on Gnosis chain`)
  if (wallet.xdai < minXdai) throw new FundsError(`the wallet holds ${xdai(wallet.xdai)} for gas, under ${xdai(minXdai)}: fund ${wallet.address} with xDAI on Gnosis chain`)
}

/** @param {bigint} wei @returns {string} */
export function xdai (wei) {
  const fraction = (wei % WEI_PER_XDAI) / 10n ** 14n
  return `${String(wei / WEI_PER_XDAI)}.${String(fraction).padStart(4, '0')} xDAI`
}
