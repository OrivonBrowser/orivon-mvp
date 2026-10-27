import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { feedUpdateAddress } from '../../src/protocols/swarm/chunk.js'
import { topicOf } from '../swarm-feeds/feed.mjs'
import { DAY, perChunkFor } from '../swarm-feeds/policy.mjs'
import { cid, manualBatch, newestIndex, OWNER, PLUR, PRICE, makeRun } from './swarm-feeds.test-helpers.js'
import type { Run } from './swarm-feeds.test-helpers.js'

const topic = { explore: topicOf('explore'), latest: topicOf('latest') }
const spends = (calls: string[]): string[] => calls.filter((c) => /^(POST|PATCH) \/(stamps|bzz|soc|feeds|tags)/.test(c))
const runs: Run[] = []
const fresh = (env: Record<string, string> = {}): Run => { const run = makeRun(env); runs.push(run); return run }
afterEach(() => { for (const run of runs.splice(0)) run.cleanup() })

describe('sync: a first run', () => {
  it('buys the two immutable batches, creates each feed manifest and writes index 0 of each site', async () => {
    const t = fresh()
    const { code } = await t.go()
    expect(code).toBe(0)
    const [pointer, content] = t.world.buys
    expect(t.world.buys.map((b) => [b.immutable, b.depth, b.label])).toEqual([[true, 18, 'orivon-pointers'], [true, 22, 'orivon-content']])
    expect(pointer!.amount).toBe(perChunkFor(240 * DAY, PRICE))
    expect(content!.amount).toBe(perChunkFor(35 * DAY, PRICE))
    expect(t.world.feeds.size).toBe(2)
    for (const key of ['explore', 'latest'] as const) expect(newestIndex(t.world, topic[key])).toBe(0)
    expect(t.world.socs.size).toBe(2)
    expect(t.world.socs.get(feedUpdateAddress(OWNER, topic.explore, 0n))?.batch).toBe(pointer!.id)
    expect(t.world.uploads.map((u) => u.batch)).toEqual([content!.id, content!.id])
    const state = t.state()
    expect(state.sites.explore).toMatchObject({ index: 0, cid: cid('a'), batch: content!.id, pending: null })
    expect(state.sites.explore.published).toBe(state.sites.explore.reference)
    expect(t.journal().map((e) => [e.key, e.index, e.cid])).toEqual([['explore', 0, cid('a')], ['latest', 0, cid('b')]])
    expect(t.status()).toMatchObject({ ok: true, pointerBatch: { id: pointer!.id, depth: 18 }, contentBatch: { id: content!.id, depth: 22, ttlDays: 35 }, errors: [] })
    expect(t.status().sites[0]).toMatchObject({ key: 'explore', names: ['explore.orivon.eth', 'explore.eth'], index: 0, manifest: `bzz://${state.sites.explore.manifest}` })
    expect(t.summary()).toMatch(/Swarm feeds: bought the pointer batch.*\n.*bought the content batch.*\n.*feed created: explore at bzz:\/\/.*\n.*feed updated: explore index 0/)
  })

  it('sends a collection upload as Orivon reads one: a tar, an index document, never an error document', async () => {
    const t = fresh()
    await t.go()
    const headers = t.world.uploads[0]!.headers
    expect(headers).toMatchObject({ 'content-type': 'application/x-tar', 'swarm-collection': 'true', 'swarm-index-document': 'index.html', 'swarm-deferred-upload': 'true' })
    expect(Object.keys(headers)).not.toContain('swarm-error-document')
  })

  it('leaves out a skipped key, and reports a key Kubo does not have without stopping the others', async () => {
    const t = fresh({ SKIP_KEYS: 'latest' })
    expect((await t.go()).code).toBe(0)
    expect(t.world.feeds.size).toBe(1)
    const u = fresh()
    u.world.keys.pop()
    expect((await u.go()).code).toBe(1)
    expect(u.world.feeds.size).toBe(1)
    expect(u.status().errors).toEqual(['latest: Kubo has no IPNS key of that name'])
  })

  it('waits for a new batch to be usable, within a bound', async () => {
    const t = fresh()
    t.world.usableAfterPolls = 3
    const before = t.clock.t
    expect((await t.go()).code).toBe(0)
    expect(t.clock.t - before).toBeGreaterThanOrEqual(20_000)
    expect(t.world.socs.size).toBe(2)
    const u = fresh({ BATCH_WAIT_MIN: '1' })
    u.world.usableAfterPolls = 1000
    expect((await u.go()).code).toBe(1)
    expect(u.status().errors[0]).toMatch(/not usable after 1 min/)
    expect(u.world.socs.size).toBe(0)
  })
})

describe('sync: later runs', () => {
  it('appends index 1 for a site whose CID moved, and does nothing for one that did not', async () => {
    const t = fresh()
    await t.go()
    t.world.cids.set('k51explore', cid('c'))
    const { code, calls } = await t.go()
    expect(code).toBe(0)
    expect(newestIndex(t.world, topic.explore)).toBe(1)
    expect(newestIndex(t.world, topic.latest)).toBe(0)
    expect(t.world.uploads).toHaveLength(3)
    expect(calls.filter((c) => c === 'POST /bzz')).toHaveLength(1)
    expect(t.state().sites.explore).toMatchObject({ index: 1, cid: cid('c') })
    const idle = await t.go()
    expect(idle.code).toBe(0)
    expect(spends(idle.calls)).toEqual([])
    expect(t.world.buys).toHaveLength(2)
  })

  it('writes the next update with the same signature the journal holds, and never skips an index', async () => {
    const t = fresh()
    await t.go()
    t.world.cids.set('k51explore', cid('c'))
    t.world.failSoc = true
    expect((await t.go()).code).toBe(1)
    expect(t.journal().filter((e) => e.key === 'explore').map((e) => e.index)).toEqual([0, 1])
    expect(t.state().sites.explore.index).toBe(0)
    expect(newestIndex(t.world, topic.explore)).toBe(0)
    t.world.failSoc = false
    expect((await t.go()).code).toBe(0)
    const sent = t.world.socs.get(feedUpdateAddress(OWNER, topic.explore, 1n))
    const journaled = t.journal().find((e) => e.key === 'explore' && e.index === 1)
    expect(sent).toMatchObject({ signature: journaled.signature, data: journaled.data })
    expect(newestIndex(t.world, topic.explore)).toBe(1)
    expect(t.state().sites.explore.index).toBe(1)
    expect(t.journal().filter((e) => e.key === 'explore')).toHaveLength(2)
  })

  it('takes the next index from the network when the state and the journal are lost', async () => {
    const t = fresh({ SKIP_KEYS: 'latest' })
    await t.go()
    t.world.cids.set('k51explore', cid('c'))
    await t.go()
    const known = new Map(t.world.socs)
    expect(newestIndex(t.world, topic.explore)).toBe(1)
    rmSync(join(t.dir, 'state'), { recursive: true })
    t.world.cids.set('k51explore', cid('d'))
    expect((await t.go()).code).toBe(0)
    expect(newestIndex(t.world, topic.explore)).toBe(2)
    for (const [address, soc] of known) expect(t.world.socs.get(address)).toEqual(soc)
  })

  it('does not write an index the node missed: a chunk found at the next index moves it on', async () => {
    const t = fresh({ SKIP_KEYS: 'latest' })
    await t.go()
    t.world.cids.set('k51explore', cid('c'))
    await t.go()
    t.world.failFeedLookup = true
    t.world.cids.set('k51explore', cid('d'))
    const state = t.state()
    state.sites.explore.index = 0
    writeFileSync(join(t.dir, 'state', 'state.json'), JSON.stringify(state))
    writeFileSync(join(t.dir, 'state', 'socs.jsonl'), t.journal().filter((e) => e.index === 0).map((e) => JSON.stringify(e)).join('\n') + '\n')
    expect((await t.go()).code).toBe(0)
    expect(newestIndex(t.world, topic.explore)).toBe(2)
  })

  it('goes by the local record when the network lookup fails, and refuses to guess when nothing is kept', async () => {
    const t = fresh({ SKIP_KEYS: 'latest' })
    await t.go()
    t.world.failFeedLookup = true
    t.world.cids.set('k51explore', cid('c'))
    expect((await t.go()).code).toBe(0)
    expect(newestIndex(t.world, topic.explore)).toBe(1)
    const u = fresh({ SKIP_KEYS: 'latest' })
    u.world.failFeedLookup = true
    expect((await u.go()).code).toBe(1)
    expect(u.status().errors[0]).toMatch(/newest index is unknown/)
    expect(u.world.socs.size).toBe(0)
  })

  it('gives a site no update while its chunks are still syncing, and publishes it from the next run without uploading again', async () => {
    const t = fresh({ SKIP_KEYS: 'latest', SYNC_TIMEOUT_MIN: '2' })
    t.world.syncStep = 0
    const first = await t.go()
    expect(first.code).toBe(1)
    expect(t.status().errors[0]).toMatch(/not synced after 2 min/)
    expect(t.world.socs.size).toBe(0)
    expect(t.world.feeds.size).toBe(1)
    expect(t.state().sites.explore.pending).toMatchObject({ cid: cid('a') })
    t.world.syncStep = 100
    const second = await t.go()
    expect(second.code).toBe(0)
    expect(second.calls).not.toContain('POST /bzz')
    expect(newestIndex(t.world, topic.explore)).toBe(0)
    expect(t.state().sites.explore.pending).toBeNull()
  })
})

describe('sync: the content batch', () => {
  it('rotates on a 402: buys a new batch, retires the old one, uploads every site into the new batch and updates only the sites whose reference changed', async () => {
    const t = fresh()
    await t.go()
    const oldContent = t.state().content.id
    t.world.stamps.get(oldContent)!.full = true
    t.world.cids.set('k51explore', cid('c'))
    const { code } = await t.go()
    expect(code).toBe(0)
    const state = t.state()
    expect(state.content.id).not.toBe(oldContent)
    expect(state.retired).toMatchObject([{ id: oldContent, depth: 22 }])
    expect(t.world.buys.at(-1)).toMatchObject({ immutable: true, depth: 22 })
    expect(state.sites.explore.batch).toBe(state.content.id)
    expect(state.sites.latest.batch).toBe(state.content.id)
    expect(newestIndex(t.world, topic.explore)).toBe(1)
    expect(newestIndex(t.world, topic.latest)).toBe(0)
    expect(t.summary()).toMatch(/rotated the content batch.*is retired, no longer topped up/)
  })

  it('rotates before uploading when the batch is three quarters full, and never tops the old one up again', async () => {
    const t = fresh()
    await t.go()
    const oldContent = t.state().content.id
    const old = t.world.stamps.get(oldContent)!
    old.utilization = 48
    old.ttl = 3 * DAY
    const { code, calls } = await t.go()
    expect(code).toBe(0)
    expect(t.state().content.id).not.toBe(oldContent)
    expect(calls.filter((c) => c.startsWith('PATCH /stamps/topup'))).toEqual([])
    expect(t.world.uploads.slice(-2).every((u) => u.batch === t.state().content.id)).toBe(true)
    expect(t.world.socs.size).toBe(2)
    t.world.cids.set('k51explore', cid('c'))
    const later = await t.go()
    expect(later.calls.filter((c) => c.startsWith('PATCH') && c.includes(oldContent))).toEqual([])
  })

  it('resumes a rotation another run left half done, without uploading again what is already in the new batch', async () => {
    const t = fresh()
    await t.go()
    const oldContent = t.state().content.id
    t.world.stamps.get(oldContent)!.utilization = 48
    t.world.syncStep = 0
    expect((await t.go()).code).toBe(1)
    const mid = t.state()
    expect(mid.content.id).not.toBe(oldContent)
    expect(mid.retired).toHaveLength(1)
    expect(mid.sites.explore.pending).toMatchObject({ batch: mid.content.id })
    t.world.syncStep = 100
    const { code, calls } = await t.go()
    expect(code).toBe(0)
    expect(calls).not.toContain('POST /bzz')
    const done = t.state()
    expect(done.retired).toHaveLength(1)
    expect(done.sites.explore.batch).toBe(done.content.id)
    expect(done.sites.latest.batch).toBe(done.content.id)
    expect(t.world.socs.size).toBe(2)
  })

  it('tops the content batch up to 35 days once it is under 21', async () => {
    const t = fresh()
    await t.go()
    const id = t.state().content.id
    t.world.stamps.get(id)!.ttl = 10 * DAY
    t.clock.t += 2 * DAY * 1000
    const { code, calls } = await t.go()
    expect(code).toBe(0)
    expect(calls).toContain(`PATCH /stamps/topup/${id}/${String(perChunkFor(25 * DAY, PRICE))}`)
    expect(t.world.stamps.get(id)!.ttl).toBeCloseTo(35 * DAY, -2)
    expect(t.summary()).toMatch(/topped up the content batch/)
  })

  it('replaces a content batch that expired, and uploads every site into the new one', async () => {
    const t = fresh()
    await t.go()
    const gone = t.state().content.id
    t.world.stamps.delete(gone)
    t.world.onChain.delete(gone)
    t.clock.t += 2 * DAY * 1000
    expect((await t.go()).code).toBe(0)
    const state = t.state()
    expect(state.content.id).not.toBe(gone)
    expect(state.sites.latest.batch).toBe(state.content.id)
    expect(newestIndex(t.world, topic.latest)).toBe(0)
  })
})

describe('sync: batches bought by hand', () => {
  const bought = (t: Run): { pointer: string, content: string } => ({
    pointer: manualBatch(t.world, { label: 'orivon-pointers', depth: 18, days: 240 }),
    content: manualBatch(t.world, { label: 'orivon-content', depth: 22, days: 35 })
  })

  it('takes up the batch under each role label and buys nothing', async () => {
    const t = fresh()
    const batches = bought(t)
    const { code } = await t.go()
    expect(code).toBe(0)
    expect(t.world.buys).toEqual([])
    expect(t.state()).toMatchObject({ pointer: { id: batches.pointer }, content: { id: batches.content } })
    expect(t.world.uploads.map((u) => u.batch)).toEqual([batches.content, batches.content])
    expect(t.world.socs.get(feedUpdateAddress(OWNER, topic.explore, 0n))?.batch).toBe(batches.pointer)
    expect(t.status()).toMatchObject({ ok: true, spentThisRun: '0.0000 xBZZ', pointerBatch: { id: batches.pointer }, contentBatch: { id: batches.content } })
    expect(t.summary()).toMatch(/adopted the pointer batch .*instead of buying one[\s\S]*adopted the content batch .*instead of buying one/)
  })

  it('takes the longest-lived of several, and passes over what cannot serve', async () => {
    const t = fresh()
    manualBatch(t.world, { label: 'orivon-pointers', depth: 18, days: 100 })
    const longest = manualBatch(t.world, { label: 'orivon-pointers', depth: 18, days: 300 })
    manualBatch(t.world, { label: 'orivon-pointers', depth: 18, days: 500, immutable: false })
    manualBatch(t.world, { label: 'orivon-pointers', depth: 18, days: 600, usable: false })
    manualBatch(t.world, { label: 'orivon-pointers', depth: 18, days: 0 })
    manualBatch(t.world, { label: 'somebody-elses', depth: 18, days: 900 })
    const roomy = manualBatch(t.world, { label: 'orivon-content', depth: 22, days: 20 })
    manualBatch(t.world, { label: 'orivon-content', depth: 22, days: 40, utilization: 52 })
    expect((await t.go()).code).toBe(0)
    expect(t.state()).toMatchObject({ pointer: { id: longest }, content: { id: roomy } })
    expect(t.world.buys.map((b) => b.label)).toEqual([])
  })

  it('buys only the role that has nothing to take up', async () => {
    const t = fresh()
    const pointer = manualBatch(t.world, { label: 'orivon-pointers', depth: 18, days: 240 })
    expect((await t.go()).code).toBe(0)
    expect(t.world.buys.map((b) => b.label)).toEqual(['orivon-content'])
    expect(t.state().pointer.id).toBe(pointer)
  })

  it('does not buy again when the state file is lost', async () => {
    const t = fresh()
    await t.go()
    const before = t.state()
    rmSync(join(t.dir, 'state', 'state.json'))
    const { code } = await t.go()
    expect(code).toBe(0)
    expect(t.world.buys).toHaveLength(2)
    expect(t.state()).toMatchObject({ pointer: { id: before.pointer.id }, content: { id: before.content.id } })
    expect(t.world.socs.size).toBe(2)
    expect(t.state().sites.explore).toMatchObject({ index: 0, manifest: before.sites.explore.manifest })
    expect(t.journal()).toHaveLength(2)
  })

  it('takes up a batch before replacing one the node no longer knows', async () => {
    const t = fresh()
    await t.go()
    const gone = t.state().content.id
    t.world.stamps.delete(gone)
    t.world.onChain.delete(gone)
    const spare = manualBatch(t.world, { label: 'orivon-content', depth: 22, days: 30 })
    t.clock.t += 2 * DAY * 1000
    expect((await t.go()).code).toBe(0)
    expect(t.world.buys).toHaveLength(2)
    expect(t.state().content.id).toBe(spare)
    expect(t.state().sites.explore.batch).toBe(spare)
  })

  it('only says what a dry run would take up, and keeps no state', async () => {
    const t = fresh()
    const batches = bought(t)
    const { code, calls } = await t.go('sync', '--dry-run')
    expect(code).toBe(0)
    expect(t.logs.some((l) => l.includes(`would adopt the pointer batch ${batches.pointer}`))).toBe(true)
    expect(t.logs.some((l) => l.includes('would buy'))).toBe(false)
    expect(spends(calls)).toEqual([])
    expect(existsSync(join(t.dir, 'state', 'state.json'))).toBe(false)
  })
})

describe('sync: the pointer batch', () => {
  it('dilutes by one level at three quarters full, then tops up if that leaves it short', async () => {
    const t = fresh()
    await t.go()
    const id = t.state().pointer.id
    const stamp = t.world.stamps.get(id)!
    stamp.utilization = 3
    stamp.ttl = 200 * DAY
    t.clock.t += 2 * DAY * 1000
    const { code, calls } = await t.go()
    expect(code).toBe(0)
    expect(calls).toContain(`PATCH /stamps/dilute/${id}/19`)
    expect(calls.filter((c) => c.startsWith(`PATCH /stamps/topup/${id}`))).toHaveLength(1)
    expect(stamp.depth).toBe(19)
    expect(stamp.ttl).toBeGreaterThan(120 * DAY)
    expect(t.summary()).toMatch(/diluted the pointer batch.*to depth 19/)
  })

  it('dilutes and retries when a feed update is refused as full', async () => {
    const t = fresh({ SKIP_KEYS: 'latest' })
    await t.go()
    const id = t.state().pointer.id
    t.world.stamps.get(id)!.full = true
    t.world.cids.set('k51explore', cid('c'))
    expect((await t.go()).code).toBe(0)
    expect(t.world.stamps.get(id)!.depth).toBe(19)
    expect(newestIndex(t.world, topic.explore)).toBe(1)
  })

  it('puts the feed manifests and every journaled update onto a new pointer batch when the old one is gone', async () => {
    const t = fresh()
    await t.go()
    t.world.cids.set('k51explore', cid('c'))
    await t.go()
    const before = new Map(t.world.socs)
    const manifests = new Map(t.world.feeds)
    const gone = t.state().pointer.id
    t.world.stamps.delete(gone)
    t.world.onChain.delete(gone)
    t.world.socs.clear()
    t.world.feeds.clear()
    t.clock.t += 2 * DAY * 1000
    expect((await t.go()).code).toBe(0)
    const state = t.state()
    expect(state.pointer.id).not.toBe(gone)
    expect(state.restorePending).toBe(false)
    for (const [address, soc] of before) expect(t.world.socs.get(address)).toMatchObject({ signature: soc.signature, data: soc.data, batch: state.pointer.id })
    expect(t.world.feeds).toEqual(manifests)
    expect(t.world.socs.size).toBe(before.size)
    expect(newestIndex(t.world, topic.explore)).toBe(1)
  })

  it('finds its updates again from the journal when only the state is lost', async () => {
    const t = fresh()
    await t.go()
    const before = new Map(t.world.socs)
    rmSync(join(t.dir, 'state', 'state.json'))
    t.world.socs.clear()
    t.world.feeds.clear()
    expect((await t.go()).code).toBe(0)
    expect(t.world.socs.size).toBe(2)
    for (const [address, soc] of before) expect(t.world.socs.get(address)).toMatchObject({ signature: soc.signature, data: soc.data })
    expect(newestIndex(t.world, topic.explore)).toBe(0)
  })
})

describe('sync: money and readiness', () => {
  it('refuses a first run whose purchases would pass MAX_SPEND_BZZ, and buys nothing', async () => {
    const t = fresh({ MAX_SPEND_BZZ: '0.5' })
    const { code, calls } = await t.go()
    expect(code).toBe(1)
    expect(spends(calls)).toEqual([])
    expect(t.status().errors[0]).toMatch(/MAX_SPEND_BZZ/)
    expect(t.world.wallet.bzz).toBe(500n * PLUR)
    expect(existsSync(join(t.dir, 'state', 'socs.jsonl'))).toBe(false)
  })

  it('says which address to fund, and buys nothing, when the wallet is short', async () => {
    const t = fresh()
    t.world.wallet.bzz = 5n * PLUR
    const { code, calls } = await t.go()
    expect(code).toBe(1)
    expect(spends(calls)).toEqual([])
    expect(t.logs.join('\n')).toMatch(/fund 0xBee0000000000000000000000000000000000001 with xBZZ/)
    const u = fresh()
    u.world.wallet.xdai = 0n
    expect((await u.go()).code).toBe(1)
    expect(u.logs.join('\n')).toMatch(/fund 0xBee\w+ with xDAI/)
    expect(u.world.buys).toEqual([])
  })

  it('a dry run prints the plan and spends, uploads and writes nothing', async () => {
    const t = fresh()
    const { code, calls } = await t.go('sync', '--dry-run')
    expect(code).toBe(0)
    expect(spends(calls)).toEqual([])
    expect(t.logs.join('\n')).toMatch(/would buy the pointer batch.*\n.*would buy the content batch/)
    expect(t.logs.join('\n')).toMatch(/would sync explore: create the feed manifest, upload version bafybei.*append feed update 0/)
    expect(existsSync(join(t.dir, 'state'))).toBe(false)
    expect(t.summary()).toBe('')
    expect(t.world.wallet.bzz).toBe(500n * PLUR)
  })

  it('a dry run says when the plan would be refused', async () => {
    const t = fresh({ MAX_SPEND_BZZ: '0.5' })
    expect((await t.go('--dry-run')).code).toBe(1)
    expect(t.logs.join('\n')).toMatch(/error: .*MAX_SPEND_BZZ/)
  })

  it('exits 1 at once, spending and asking Kubo nothing, while Bee is starting or has no peers', async () => {
    const t = fresh()
    t.world.ready = false
    const starting = await t.go()
    expect(starting.code).toBe(1)
    expect(starting.calls).toEqual(['GET /readiness'])
    expect(t.logs.join('\n')).toMatch(/still starting; nothing was done/)
    t.world.ready = true
    t.world.peers = 0
    const alone = await t.go()
    expect(alone.code).toBe(1)
    expect(alone.calls).toEqual(['GET /readiness', 'GET /topology'])
    expect(t.status()).toMatchObject({ ok: false, wallet: null, pointerBatch: null })
    expect(t.world.buys).toEqual([])
  })

  it('carries on after days off: both batches nearly out of life are topped up, and the site that moved is published', async () => {
    const t = fresh()
    await t.go()
    t.clock.t += 100 * DAY * 1000
    t.world.stamps.get(t.state().pointer.id)!.ttl = 20 * DAY
    t.world.stamps.get(t.state().content.id)!.ttl = 5 * DAY
    t.world.cids.set('k51explore', cid('c'))
    const { code, calls } = await t.go()
    expect(code).toBe(0)
    expect(calls.filter((c) => c.startsWith('PATCH /stamps/topup'))).toHaveLength(2)
    expect(newestIndex(t.world, topic.explore)).toBe(1)
    expect(t.status().pointerBatch.ttlDays).toBeCloseTo(240, -1)
  })
})

describe('list and address', () => {
  it('lists each site with its manifest, newest index, CID and Swarm reference', async () => {
    const t = fresh()
    await t.go()
    const { code } = await t.go('list')
    expect(code).toBe(0)
    const state = t.state()
    expect(t.outs[0]).toContain('| Key | ENS names | Feed manifest | Newest index | IPFS CID | Swarm reference |')
    expect(t.outs[0]).toContain(`| explore | explore.orivon.eth, explore.eth | bzz://${String(state.sites.explore.manifest)} | 0 | ${cid('a')} | ${String(state.sites.explore.reference)} |`)
    expect(t.outs[0]).toContain(`| latest | latest.orivon.eth | bzz://${String(state.sites.latest.manifest)} | 0 |`)
  })
  it('prints the feed owner and the Bee wallet', async () => {
    const t = fresh()
    expect((await t.go('address')).code).toBe(0)
    expect(t.outs).toEqual(['feed owner: 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf', 'bee wallet: 0xBee0000000000000000000000000000000000001'])
  })
})

describe('configuration errors', () => {
  it('exits 2 when NAMES_FILE is not set, when the key file is readable by others, and for an unknown command', async () => {
    const t = fresh()
    delete (t.env as Record<string, string | undefined>).NAMES_FILE
    expect((await t.go()).code).toBe(2)
    const u = fresh()
    chmodSync(u.env.SIGNER_KEY_FILE, 0o644)
    expect((await u.go()).code).toBe(2)
    expect((await fresh().go('frobnicate')).code).toBe(2)
    expect((await fresh().go('list', '--dry-run')).code).toBe(2)
  })
})
