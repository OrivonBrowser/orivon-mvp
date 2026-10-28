/**
 * The two immutable postage batches. The pointer batch holds feed manifests and every feed update, and is never
 * replaced: a reader on a fresh profile finds the newest update by probing from index 0, so every past update must stay.
 * The content batch holds the site versions, and is replaced (rotated) when it fills: the old one is no longer topped up,
 * so it expires with the old versions in it. Mutable batches are never used: a full one overwrites chunks still live.
 *
 * @typedef {{ cfg: any, bee: ReturnType<typeof import('./bee.mjs').beeClient>, state: import('./store.mjs').State, spend: import('./policy.mjs').SpendBudget, log: (line: string) => void, summary: (line: string) => void, now: () => number, sleep: (ms: number) => Promise<void>, journal: import('./store.mjs').Soc[], signer: { privateKey: string, owner: string }, rotated: boolean }} Ctx
 */
import { BatchFullError } from './bee.mjs'
import { topicOf } from './feed.mjs'
import { bzz, checkPlan, costOf, DAY, perChunkFor, planBatches, topUpFor, within } from './policy.mjs'
import { saveState } from './store.mjs'

const POLL_MS = 10_000
const ROLES = /** @type {const} */ (['pointer', 'content'])
/** The label each role's batch is bought with, and the one a batch carries to be taken up for that role. */
export const LABELS = { pointer: 'orivon-pointers', content: 'orivon-content' }

/** @param {Ctx} ctx */
const save = (ctx) => { saveState(ctx.cfg.stateDir, ctx.state) }
/** @param {Ctx} ctx */
const stamp = (ctx) => new Date(ctx.now()).toISOString()

/**
 * Polls until `probe` answers something, or `ms` have passed.
 * @template T
 * @param {Ctx} ctx
 * @param {() => Promise<T | null | false>} probe
 * @returns {Promise<T | null>}
 */
async function waitFor (ctx, probe) {
  const deadline = ctx.now() + ctx.cfg.waitMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (ctx.now() >= deadline) return null
    await ctx.sleep(POLL_MS)
  }
}

/**
 * The batch a role takes up instead of buying: one the node holds under the role's label that is usable, immutable and
 * not expired, and (for content) not already at the rotation fill; the longest-lived if several. A batch the state
 * already uses or has retired is never taken.
 * @param {{ stamps: import('./bee.mjs').Stamp[], role: 'pointer' | 'content', cfg: any, state: import('./store.mjs').State }} input
 * @returns {import('./bee.mjs').Stamp | null}
 */
export function adoptable ({ stamps, role, cfg, state }) {
  const taken = new Set([state.pointer?.id, state.content?.id, ...state.retired.map((batch) => batch.id)])
  const label = LABELS[role]
  return stamps
    .filter((s) => s.found && s.usable && s.immutable && s.ttl > 0 && (s.label === label || s.label.startsWith(`${label}-`)) && !taken.has(s.id) && (role !== 'content' || s.fill < cfg.rotateAt))
    .sort((a, b) => (a.ttl === b.ttl ? 0 : b.ttl > a.ttl ? 1 : -1))[0] ?? null
}

/**
 * Records a batch the node already holds as the role's batch. `persist` false (a dry run) changes the state in memory
 * only.
 * @param {Ctx} ctx
 * @param {'pointer' | 'content'} role
 * @param {import('./bee.mjs').Stamp} picked
 * @param {boolean} persist
 */
function adopt (ctx, role, picked, persist) {
  // Updates and manifests are put onto an adopted pointer batch too: it may never have held them.
  if (role === 'pointer' && hasPointerData(ctx)) ctx.state.restorePending = true
  ctx.state[role] = { id: picked.id, depth: picked.depth, label: picked.label, adoptedAt: stamp(ctx) }
  const what = `the ${role} batch ${picked.id} (label ${picked.label}, depth ${String(picked.depth)}, ${picked.ttl === Infinity ? 'no expiry' : `${String(Math.round(picked.ttl / DAY))} days left`}) instead of buying one`
  ctx.log(`${persist ? '' : 'would '}adopt ${what}`)
  if (!persist) return
  save(ctx)
  ctx.summary(`adopted ${what}`)
}

/**
 * Reads the price, the wallet and each batch of the state. A role with no batch in the state, or whose batch is gone
 * (and was not bought moments ago), first looks for a batch to take up, and only the plan that follows buys.
 * @param {Ctx} ctx
 * @param {{ persist: boolean }} options `persist` false: adopt in memory only (a dry run)
 * @returns {Promise<{ price: bigint, wallet: { address: string, bzz: bigint, xdai: bigint }, seen: { pointer: any, content: any } }>}
 */
export async function observe (ctx, { persist }) {
  const price = await ctx.bee.price()
  const wallet = await ctx.bee.wallet()
  /** @type {{ pointer: any, content: any }} */
  const seen = { pointer: null, content: null }
  /** @type {import('./bee.mjs').Stamp[] | null} */
  let listed = null
  for (const role of ROLES) {
    const held = ctx.state[role]
    if (held !== null) {
      seen[role] = await ctx.bee.stamp(held.id)
      if (seen[role].found && seen[role].usable && !seen[role].immutable) throw new Error(`batch ${held.id} is mutable, and this job only uses immutable batches: a full mutable one overwrites chunks that are still live`)
      if (seen[role].found || within(held.boughtAt, ctx.now(), 3 * ctx.cfg.waitMs)) continue
    }
    listed ??= await ctx.bee.stamps()
    const picked = adoptable({ stamps: listed, role, cfg: ctx.cfg, state: ctx.state })
    if (picked === null) continue
    adopt(ctx, role, picked, persist)
    seen[role] = picked
  }
  return { price, wallet, seen }
}

/**
 * The batch operations this run needs, checked as a whole against the wallet and the spending limit before the first
 * one is done.
 * @param {Ctx} ctx
 * @param {Awaited<ReturnType<typeof observe>>} observed
 */
export function planFor (ctx, observed) {
  return planBatches({ cfg: ctx.cfg, held: ctx.state, seen: observed.seen, price: observed.price, now: ctx.now() })
}

/** @param {Ctx} ctx @param {ReturnType<typeof planFor>} plan @param {Awaited<ReturnType<typeof observe>>} observed */
export function checkAffordable (ctx, plan, observed) {
  checkPlan({ plan, wallet: observed.wallet, budget: ctx.spend, minXdai: ctx.cfg.minXdai })
}

/** @param {Ctx} ctx @param {bigint} cost @param {string} what */
async function spendOn (ctx, cost, what) {
  if (!ctx.spend.allows(cost)) ctx.spend.charge(cost, what)
  checkPlan({ plan: [{ cost, op: what }], wallet: await ctx.bee.wallet(), budget: ctx.spend, minXdai: ctx.cfg.minXdai })
  ctx.spend.charge(cost, what)
}

/** @param {Ctx} ctx @param {'pointer' | 'content'} role @returns {Promise<void>} */
async function buyBatch (ctx, role) {
  const limits = ctx.cfg[role]
  const perChunk = perChunkFor(limits.targetDays * DAY, await ctx.bee.price())
  const cost = costOf(perChunk, limits.depth)
  await spendOn(ctx, cost, `buy a ${role} batch`)
  const label = LABELS[role]
  const id = await ctx.bee.buyBatch({ amount: perChunk, depth: limits.depth, label })
  const at = stamp(ctx)
  ctx.state[role] = { id, depth: limits.depth, label, boughtAt: at, changedAt: at }
  save(ctx)
  ctx.summary(`bought the ${role} batch ${id} (depth ${String(limits.depth)}, ${String(limits.targetDays)} days, ${bzz(cost)})`)
  ctx.log(`bought the ${role} batch ${id}`)
}

/** Waits until a batch is usable. @param {Ctx} ctx @param {'pointer' | 'content'} role */
export async function waitUsable (ctx, role) {
  const held = ctx.state[role]
  const found = await waitFor(ctx, async () => {
    const s = await ctx.bee.stamp(held.id)
    return s.found && s.usable ? s : null
  })
  if (found === null) throw new Error(`the ${role} batch ${held.id} is not usable after ${String(ctx.cfg.waitMs / 60_000)} min; it is used as soon as it is`)
  if (!found.immutable) throw new Error(`batch ${held.id} is mutable, and this job only uses immutable batches`)
  return found
}

/** @param {Ctx} ctx @param {'pointer' | 'content'} role @returns {Promise<void>} */
async function topUpBatch (ctx, role) {
  const held = ctx.state[role]
  const before = await ctx.bee.stamp(held.id)
  const topUp = topUpFor(before, ctx.cfg[role], await ctx.bee.price())
  if (topUp === null) return
  await spendOn(ctx, topUp.cost, `top up the ${role} batch`)
  await ctx.bee.topUp(held.id, topUp.perChunk)
  held.changedAt = stamp(ctx)
  save(ctx)
  ctx.summary(`topped up the ${role} batch ${held.id} by ${String(Math.round(topUp.seconds / DAY))} days (${bzz(topUp.cost)})`)
  const raised = await waitFor(ctx, async () => (await ctx.bee.stamp(held.id)).ttl >= before.ttl + topUp.seconds / 2)
  if (raised === null) ctx.log(`the top-up of the ${role} batch is not visible yet; nothing more is added to it for ${String(ctx.cfg.settleMs / 60_000)} min`)
}

/** One more level of depth: room for twice the chunks, half the life. @param {Ctx} ctx @param {'pointer' | 'content'} role @returns {Promise<void>} */
async function diluteBatch (ctx, role) {
  const held = ctx.state[role]
  const before = await ctx.bee.stamp(held.id)
  await spendOn(ctx, 0n, `dilute the ${role} batch`)
  await ctx.bee.dilute(held.id, before.depth + 1)
  held.changedAt = stamp(ctx)
  held.depth = before.depth + 1
  save(ctx)
  ctx.summary(`diluted the ${role} batch ${held.id} to depth ${String(before.depth + 1)}`)
  const seen = await waitFor(ctx, async () => (await ctx.bee.stamp(held.id)).depth > before.depth)
  if (seen === null) ctx.log(`the dilution of the ${role} batch is not visible yet`)
}

/**
 * Buys a new content batch and retires the old one. Every site whose version is not in the new batch is uploaded again
 * from its current CID by the site step, one at a time, with its progress in the state, so a run that stops halfway is
 * picked up by the next.
 * @param {Ctx} ctx
 * @param {string} reason
 * @returns {Promise<void>}
 */
export async function rotateContent (ctx, reason) {
  const old = ctx.state.content
  await buyBatch(ctx, 'content')
  ctx.rotated = true
  if (old !== null) {
    ctx.state.retired.push({ id: old.id, depth: old.depth, retiredAt: stamp(ctx), reason })
    save(ctx)
    ctx.summary(`rotated the content batch (${reason}): ${old.id} is retired, no longer topped up, and expires with the old versions; the new batch is ${ctx.state.content.id}`)
  }
}

/** @param {Ctx} ctx */
const hasPointerData = (ctx) => ctx.journal.length > 0 || Object.values(ctx.state.sites).some((site) => site.manifest !== undefined)

/**
 * Carries out a plan in order: each step looks at the batch again first, so a step that is no longer needed does nothing.
 * @param {Ctx} ctx
 * @param {ReturnType<typeof planFor>} plan
 */
export async function runPlan (ctx, plan) {
  for (const step of plan) {
    ctx.log(`${step.op} the ${step.role} batch: ${step.why}`)
    if (step.op === 'buy') {
      // Updates and manifests that lived on a replaced pointer batch are put onto the new one.
      if (step.role === 'pointer' && hasPointerData(ctx)) ctx.state.restorePending = true
      await buyBatch(ctx, step.role)
    } else if (step.op === 'rotate') {
      await rotateContent(ctx, step.why)
    } else if (step.op === 'dilute') {
      await diluteBatch(ctx, step.role)
    } else {
      await topUpBatch(ctx, step.role)
    }
  }
}

/**
 * Puts every feed manifest and every journaled update onto the current pointer batch. The manifest is made again
 * rather than copied: the same owner and topic give the same reference, and it does not need the old chunks, which may be
 * gone with the old batch.
 * @param {Ctx} ctx
 */
export async function restorePointer (ctx) {
  const batch = ctx.state.pointer.id
  const keys = new Set([...Object.keys(ctx.state.sites).filter((key) => ctx.state.sites[key].manifest !== undefined), ...ctx.journal.map((soc) => soc.key)])
  for (const key of keys) {
    const topic = topicOf(key)
    const reference = await ctx.bee.createFeed({ owner: ctx.signer.owner, topic, batch })
    const site = (ctx.state.sites[key] ??= { topic })
    if (site.manifest !== undefined && site.manifest !== reference) ctx.log(`warning: the feed manifest of ${key} is bzz://${reference}, the state had bzz://${String(site.manifest)}`)
    site.manifest = reference
  }
  for (const soc of ctx.journal) {
    const address = await ctx.bee.uploadSoc({ owner: ctx.signer.owner, identifier: soc.identifier, signature: soc.signature, data: soc.data, batch })
    if (address.length !== 64) throw new Error(`Bee answered "${address}" for the update ${String(soc.index)} of ${soc.key}`)
    const site = ctx.state.sites[soc.key]
    if (site !== undefined && soc.index > (site.index ?? -1)) Object.assign(site, { index: soc.index, published: soc.reference })
  }
  ctx.state.restorePending = false
  save(ctx)
  ctx.summary(`put ${String(keys.size)} feed manifest(s) and ${String(ctx.journal.length)} update(s) onto the pointer batch ${batch}`)
}

/**
 * Runs `work` with the pointer batch's id. A batch that answers 402 has no free slot in a bucket the chunk falls into:
 * it is diluted one level (with a top-up if that leaves it short) and `work` is tried once more.
 * @template T
 * @param {Ctx} ctx
 * @param {(batch: string) => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withPointer (ctx, work) {
  try {
    return await work(ctx.state.pointer.id)
  } catch (error) {
    if (!(error instanceof BatchFullError)) throw error
    ctx.log('the pointer batch answered full: diluting it one level')
    await diluteBatch(ctx, 'pointer')
    await topUpBatch(ctx, 'pointer')
    return work(ctx.state.pointer.id)
  }
}
