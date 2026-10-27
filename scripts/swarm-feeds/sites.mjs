/**
 * One site at a time: its feed manifest, its current version uploaded into the content batch and synced, and a feed
 * update that names it. The state records each step as it is done, so a run that stops anywhere is finished by the next.
 * A site gets an update only when its version is in the content batch and every chunk of it has reached the network.
 *
 * @typedef {{ key: string, names: string[], id: string, cid: string }} Site a site and the CID its IPNS key points at now
 */
import { BatchFullError } from './bee.mjs'
import { rotateContent, waitUsable, withPointer } from './batches.mjs'
import { buildUpdate, identifierHex, topicOf } from './feed.mjs'
import { FundsError, SpendCapError } from './policy.mjs'
import { appendJournal, saveState } from './store.mjs'

const SYNC_POLL_MS = 5_000
const MAX_INDEX_PROBES = 64

/** @typedef {import('./batches.mjs').Ctx & { pack: (input: { cid: string, workDir: string }) => Promise<{ file: string, bytes: number, hasIndex: boolean, cleanup: () => void }> }} SiteCtx */

/** @param {SiteCtx} ctx */
const save = (ctx) => { saveState(ctx.cfg.stateDir, ctx.state) }
/** @param {string} text */
const short = (text) => `${text.slice(0, 12)}...`

/** @param {SiteCtx} ctx @param {string} key @returns {number} the newest journaled index, -1 for none */
const journaled = (ctx, key) => ctx.journal.reduce((top, soc) => (soc.key === key ? Math.max(top, soc.index) : top), -1)

/**
 * Whether the version in the state is the one to publish: this CID, uploaded into the batch that is current.
 * @param {any} rec
 * @param {string} cid
 * @param {string} batch
 */
const hasVersion = (rec, cid, batch) => rec?.reference !== undefined && rec.cid === cid && rec.batch === batch

/**
 * What a run would do for each site, for `--dry-run`.
 * @param {SiteCtx} ctx
 * @param {Site[]} sites
 * @returns {string[]}
 */
export function describeSites (ctx, sites) {
  const batch = ctx.state.content?.id
  return sites.map((site) => {
    const rec = ctx.state.sites[site.key]
    /** @type {string[]} */
    const steps = []
    if (rec?.manifest === undefined) steps.push('create the feed manifest')
    const upload = !hasVersion(rec, site.cid, batch)
    if (upload) steps.push(rec?.cid === site.cid && rec?.reference !== undefined ? 'upload the same version into the new content batch' : `upload version ${site.cid}`)
    if (upload || rec.reference !== rec.published) steps.push(`append feed update ${String(Math.max(rec?.index ?? -1, journaled(ctx, site.key)) + 1)}`)
    return `${site.key}: ${steps.length === 0 ? 'unchanged' : steps.join(', ')}`
  })
}

/**
 * Polls the upload's tag until every chunk it made is synced or was already there.
 * @param {SiteCtx} ctx
 * @param {number} tag
 * @returns {Promise<boolean>}
 */
async function waitSynced (ctx, tag) {
  const deadline = ctx.now() + ctx.cfg.syncTimeoutMs
  for (;;) {
    const { split, seen, synced } = await ctx.bee.tag(tag)
    if (split > 0 && synced + seen >= split) return true
    if (ctx.now() >= deadline) return false
    await ctx.sleep(SYNC_POLL_MS)
  }
}

/**
 * Uploads a version into the content batch. A batch that answers 402 is full: it is rotated once, and the same tar goes
 * into the new one.
 * @param {SiteCtx} ctx
 * @param {string} key
 * @param {string} cid
 */
async function uploadVersion (ctx, key, cid) {
  const packed = await ctx.pack({ cid, workDir: ctx.cfg.workDir })
  try {
    if (!packed.hasIndex) ctx.log(`warning: ${key} (${cid}) has no index.html at its root`)
    for (;;) {
      const batch = ctx.state.content.id
      const tag = await ctx.bee.createTag()
      try {
        const reference = await ctx.bee.uploadSite({ file: packed.file, batch, tag })
        return { cid, reference, batch, tag, at: new Date(ctx.now()).toISOString() }
      } catch (error) {
        if (!(error instanceof BatchFullError) || ctx.rotated) throw error
        await rotateContent(ctx, 'an upload was refused as full')
        await waitUsable(ctx, 'content')
      }
    }
  } finally {
    packed.cleanup()
  }
}

/**
 * Gets the current version of a site into the content batch and synced, or throws. An upload still being pushed from an
 * earlier run is waited for, not started again.
 * @param {SiteCtx} ctx
 * @param {string} key
 * @param {any} rec
 * @param {string} cid
 */
async function ensureVersion (ctx, key, rec, cid) {
  const pending = rec.pending
  const resumable = pending && pending.cid === cid && pending.batch === ctx.state.content.id && ctx.now() - Date.parse(pending.at) < 3 * ctx.cfg.syncTimeoutMs
  if (!resumable) {
    rec.pending = await uploadVersion(ctx, key, cid)
    save(ctx)
    ctx.log(`${key}: uploaded ${cid} as bzz://${rec.pending.reference}`)
  } else {
    ctx.log(`${key}: waiting for the chunks of bzz://${short(pending.reference)} to sync`)
  }
  if (!await waitSynced(ctx, rec.pending.tag)) throw new Error(`${key}: the chunks of bzz://${short(rec.pending.reference)} are not synced after ${String(ctx.cfg.syncTimeoutMs / 60_000)} min; no feed update until they are`)
  Object.assign(rec, { cid, reference: rec.pending.reference, batch: rec.pending.batch, pending: null })
  save(ctx)
}

/**
 * The index the next update takes: past everything this job has written and everything the network shows, so a lost
 * state never writes an index twice (two readers would then disagree about what it names).
 * @param {SiteCtx} ctx
 * @param {string} key
 * @param {any} rec
 * @returns {Promise<number>}
 */
async function nextIndex (ctx, key, rec) {
  const topic = rec.topic
  const local = Math.max(rec.index ?? -1, journaled(ctx, key))
  let network = -1
  try {
    network = (await ctx.bee.feedIndex({ owner: ctx.signer.owner, topic })) ?? -1
  } catch (error) {
    if (local < 0) throw new Error(`${key}: the feed's newest index is unknown (${error instanceof Error ? error.message : String(error)}), and nothing is kept locally: no update, so no index is written twice`)
    ctx.log(`${key}: the network's index was not read (${error instanceof Error ? error.message : String(error)}); going by the local record`)
  }
  let index = Math.max(local, network) + 1
  // The node's own lookup stops at a gap and gives up on a slow probe; a chunk at the next index means it missed one.
  for (let probes = 0; probes < MAX_INDEX_PROBES; probes++) {
    const taken = await ctx.bee.socExists({ owner: ctx.signer.owner, identifier: identifierHex(topic, index) }).catch(() => false)
    if (!taken) break
    index++
  }
  return index
}

/** @param {SiteCtx} ctx @param {string} key @param {any} rec */
async function publish (ctx, key, rec) {
  const index = await nextIndex(ctx, key, rec)
  const update = await buildUpdate({ privateKey: ctx.signer.privateKey, topic: rec.topic, index, reference: rec.reference, timestamp: Math.floor(ctx.now() / 1000) })
  const entry = { key, topic: rec.topic, index, identifier: update.identifier, signature: update.signature, data: update.data, reference: rec.reference, cid: rec.cid, time: new Date(ctx.now()).toISOString() }
  appendJournal(ctx.cfg.stateDir, entry)
  ctx.journal.push(entry)
  const address = await withPointer(ctx, (batch) => ctx.bee.uploadSoc({ owner: update.owner, identifier: update.identifier, signature: update.signature, data: update.data, batch }))
  if (address !== update.address) throw new Error(`${key}: Bee stored update ${String(index)} at ${address}, not at ${update.address}`)
  Object.assign(rec, { index, published: rec.reference })
  save(ctx)
  ctx.summary(`feed updated: ${key} index ${String(index)} now names bzz://${rec.reference} (IPFS ${rec.cid})`)
  ctx.log(`${key}: feed index ${String(index)} names bzz://${short(rec.reference)}`)
}

/**
 * @param {SiteCtx} ctx
 * @param {Site} site
 */
export async function syncSite (ctx, site) {
  const { key, cid } = site
  const rec = (ctx.state.sites[key] ??= { topic: topicOf(key) })
  // An update signed and journaled by a run that stopped before the node took it is sent again as it was: skipping
  // its index would leave a gap, and a reader stops at the first one.
  const newest = ctx.journal.filter((soc) => soc.key === key).reduce((top, soc) => (top === undefined || soc.index > top.index ? soc : top), /** @type {import('./store.mjs').Soc | undefined} */ (undefined))
  if (newest !== undefined && newest.index > (rec.index ?? -1)) {
    await withPointer(ctx, (batch) => ctx.bee.uploadSoc({ owner: ctx.signer.owner, identifier: newest.identifier, signature: newest.signature, data: newest.data, batch }))
    Object.assign(rec, { index: newest.index, published: newest.reference })
    save(ctx)
    ctx.log(`${key}: sent the journaled update ${String(newest.index)} again`)
  }
  if (rec.manifest === undefined) {
    rec.manifest = await withPointer(ctx, (batch) => ctx.bee.createFeed({ owner: ctx.signer.owner, topic: rec.topic, batch }))
    save(ctx)
    ctx.summary(`feed created: ${key} at bzz://${rec.manifest}`)
    ctx.log(`${key}: feed manifest bzz://${rec.manifest}`)
  }
  if (!hasVersion(rec, cid, ctx.state.content.id)) await ensureVersion(ctx, key, rec, cid)
  if (rec.reference !== rec.published) await publish(ctx, key, rec)
}

/**
 * Every site, in turn. A site's failure is recorded and the others go on; a refusal to spend, or an empty wallet, stops
 * the run because it would fail every site the same way.
 * @param {SiteCtx} ctx
 * @param {Site[]} sites
 * @param {string[]} errors
 */
export async function syncSites (ctx, sites, errors) {
  for (const site of sites) {
    try {
      await syncSite(ctx, site)
    } catch (error) {
      if (error instanceof SpendCapError || error instanceof FundsError) throw error
      const message = error instanceof Error ? error.message : String(error)
      errors.push(message.startsWith(`${site.key}:`) ? message : `${site.key}: ${message}`)
      ctx.log(errors[errors.length - 1] ?? message)
    }
  }
}
