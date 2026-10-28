import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CID } from 'multiformats/cid'
import { identity } from 'multiformats/hashes/identity'
import { base36 } from 'multiformats/bases/base36'
import { MAX_FEEDS, MAX_IPNS_KEYS, MAX_NAME_SCHEMES, VerifierStore } from '../verifier-store.js'

const dirs: string[] = []
function store (): { store: VerifierStore, dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-verifier-store-'))
  dirs.push(dir)
  return { store: new VerifierStore(join(dir, 'verifier')), dir: join(dir, 'verifier') }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const root = (c: string): string => '0x' + c.repeat(64)
const NOW = 1_850_000_000

/** A key in the base36 CID form `saveIpnsSequence` actually accepts: an
 * inlined (identity-hashed) libp2p public key, deterministic in `seed` so
 * two calls with the same seed name the same key. */
const LIBP2P_KEY_CODEC = 0x72
async function ipnsKey (seed: string): Promise<string> {
  const digest = await identity.digest(new TextEncoder().encode(seed))
  return CID.createV1(LIBP2P_KEY_CODEC, digest).toString(base36)
}
const KEY_1 = await ipnsKey('verifier-store-test-key-one')
const KEY_2 = await ipnsKey('verifier-store-test-key-two')

describe('VerifierStore', () => {
  it('reads nothing before anything is saved', () => {
    const { store: s } = store()
    expect(s.checkpoint()).toBeUndefined()
    expect(s.ipnsSequences()).toEqual({})
  })

  it('keeps a checkpoint across instances, and only ever a newer one', () => {
    const { store: s, dir } = store()
    s.saveCheckpoint({ root: root('a'), timestamp: 1_700_000_000 }, NOW)
    s.saveCheckpoint({ root: root('b'), timestamp: 1_600_000_000 }, NOW)
    expect(new VerifierStore(dir).checkpoint()).toEqual({ root: root('a'), timestamp: 1_700_000_000 })
    s.saveCheckpoint({ root: root('c'), timestamp: 1_800_000_000 }, NOW)
    expect(s.checkpoint()?.root).toBe(root('c'))
  })

  it('keeps the servers that agreed on a fetched checkpoint, until the light client stores a newer one', () => {
    const { store: s, dir } = store()
    const servers = ['https://a.example', 'https://b.example']
    s.saveFetchedCheckpoint({ root: root('a'), timestamp: 1_700_000_000 }, servers, NOW)
    expect(new VerifierStore(dir).checkpoint()).toEqual({ root: root('a'), timestamp: 1_700_000_000, fetchedFrom: servers })
    s.saveCheckpoint({ root: root('b'), timestamp: 1_700_000_100 }, NOW)
    expect(s.checkpoint()).toEqual({ root: root('b'), timestamp: 1_700_000_100 })
  })

  it('does not let a fetched checkpoint replace a newer one, or one dated in the future', () => {
    const { store: s } = store()
    s.saveCheckpoint({ root: root('a'), timestamp: 1_700_000_000 }, NOW)
    s.saveFetchedCheckpoint({ root: root('b'), timestamp: 1_600_000_000 }, ['https://a.example'], NOW)
    s.saveFetchedCheckpoint({ root: root('c'), timestamp: NOW + 24 * 3600 }, ['https://a.example'], NOW)
    expect(s.checkpoint()).toEqual({ root: root('a'), timestamp: 1_700_000_000 })
  })

  it('lets a fetched checkpoint replace a stored one the beacon server has no bootstrap for, even when it is not newer', () => {
    const { store: s, dir } = store()
    const servers = ['https://a.example']
    s.saveCheckpoint({ root: root('a'), timestamp: 1_700_000_000 }, NOW)
    s.saveFetchedCheckpoint({ root: root('b'), timestamp: 1_699_999_000 }, servers, NOW, new Set([root('z')]))
    expect(s.checkpoint()).toEqual({ root: root('a'), timestamp: 1_700_000_000 })
    s.saveFetchedCheckpoint({ root: root('b'), timestamp: 1_699_999_000 }, servers, NOW, new Set([root('a')]))
    expect(new VerifierStore(dir).checkpoint()).toEqual({ root: root('b'), timestamp: 1_699_999_000, fetchedFrom: servers })
  })

  it('still refuses a malformed or future checkpoint when it would replace one with no bootstrap', () => {
    const { store: s } = store()
    s.saveCheckpoint({ root: root('a'), timestamp: 1_700_000_000 }, NOW)
    s.saveFetchedCheckpoint({ root: root('c'), timestamp: NOW + 24 * 3600 }, ['https://a.example'], NOW, new Set([root('a')]))
    s.saveFetchedCheckpoint({ root: 'nope', timestamp: 1_699_999_000 }, ['https://a.example'], NOW, new Set([root('a')]))
    expect(s.checkpoint()).toEqual({ root: root('a'), timestamp: 1_700_000_000 })
  })

  it('refuses to save a malformed checkpoint, or one dated in the future', () => {
    const { store: s } = store()
    s.saveCheckpoint({ root: 'nope', timestamp: 1_700_000_000 }, NOW)
    s.saveCheckpoint({ root: root('d'), timestamp: NOW + 24 * 3600 }, NOW)
    expect(s.checkpoint()).toBeUndefined()
  })

  it('keeps the highest IPNS sequence per key, once flushed', async () => {
    const { store: s, dir } = store()
    s.saveIpnsSequence(KEY_1, '5')
    s.saveIpnsSequence(KEY_1, '3')
    s.saveIpnsSequence(KEY_2, '18446744073709551615')
    s.saveIpnsSequence(KEY_1, 'x') // not a decimal sequence
    s.saveIpnsSequence('not-a-cid', '1') // not an IPNS key at all
    await s.flush()
    expect(new VerifierStore(dir).ipnsSequences()).toEqual({ [KEY_1]: '5', [KEY_2]: '18446744073709551615' })
  })

  it('keeps the highest Swarm feed index per feed, beside the IPNS sequences, and refuses a key that is not a feed', async () => {
    const { store: s, dir } = store()
    const feed = `${'ab'.repeat(20)}/${'cd'.repeat(32)}`
    s.saveSwarmFeedIndex(feed, '91')
    s.saveSwarmFeedIndex(feed, '12')
    s.saveSwarmFeedIndex('not/a-feed', '1')
    s.saveSwarmFeedIndex(`${'AB'.repeat(20)}/${'cd'.repeat(32)}`, '1') // uppercase is never how the host spells one
    s.saveSwarmFeedIndex(`${'ee'.repeat(20)}/${'cd'.repeat(32)}`, 'x')
    s.saveIpnsSequence(KEY_1, '5')
    await s.flush()
    const again = new VerifierStore(dir)
    expect(again.swarmFeedIndexes()).toEqual({ [feed]: '91' })
    expect(again.ipnsSequences()).toEqual({ [KEY_1]: '5' })
  })

  it('drops the least recently touched feed past its cap', () => {
    const { store: s } = store()
    for (let i = 0; i <= MAX_FEEDS; i++) s.saveSwarmFeedIndex(`${i.toString(16).padStart(40, '0')}/${'cd'.repeat(32)}`, '1')
    const kept = Object.keys(s.swarmFeedIndexes())
    expect(kept).toHaveLength(MAX_FEEDS)
    expect(kept).not.toContain(`${'0'.repeat(40)}/${'cd'.repeat(32)}`)
  })

  it('reads a corrupt feed-index file as empty', async () => {
    const { store: s, dir } = store()
    s.saveSwarmFeedIndex(`${'ab'.repeat(20)}/${'cd'.repeat(32)}`, '1')
    await s.flush()
    writeFileSync(join(dir, 'swarm-feed-indexes.json'), '{nope')
    expect(new VerifierStore(dir).swarmFeedIndexes()).toEqual({})
  })

  it('keeps the scheme a .eth name was last found under across instances, the newest answer winning, and refuses the rest', async () => {
    const { store: s, dir } = store()
    expect(s.saveNameScheme('swarm.eth', 'bzz')).toBe(true)
    expect(s.saveNameScheme('swarm.eth', 'bzz')).toBe(false)
    expect(s.saveNameScheme('moved.eth', 'bzz')).toBe(true)
    expect(s.saveNameScheme('moved.eth', 'ipfs')).toBe(true)
    expect(s.saveNameScheme('Upper.eth', 'bzz')).toBe(false) // never how the host spells a name
    expect(s.saveNameScheme('example.com', 'bzz')).toBe(false)
    expect(s.saveNameScheme('x.eth', 'gopher')).toBe(false)
    expect(s.nameScheme('moved.eth')).toBe('ipfs')
    await s.flush()
    const again = new VerifierStore(dir)
    expect(again.nameScheme('swarm.eth')).toBe('bzz')
    expect(again.nameScheme('moved.eth')).toBe('ipfs')
    expect(again.nameScheme('x.eth')).toBeUndefined()
  })

  it('drops the least recently touched name past its cap, a name seen again counting as touched', () => {
    const { store: s } = store()
    for (let i = 0; i < MAX_NAME_SCHEMES; i++) s.saveNameScheme(`n${String(i)}.eth`, 'bzz')
    s.saveNameScheme('n0.eth', 'bzz')
    s.saveNameScheme('one-more.eth', 'bzz')
    expect(s.nameScheme('n0.eth')).toBe('bzz')
    expect(s.nameScheme('n1.eth')).toBeUndefined()
    expect(s.nameScheme('one-more.eth')).toBe('bzz')
  })

  it('forgets every name scheme in memory and in the file, and keeps what it learns afterwards', async () => {
    const { store: s, dir } = store()
    s.saveNameScheme('swarm.eth', 'bzz')
    s.saveNameScheme('a.eth', 'ipfs')
    await s.flush()
    s.saveIpnsSequence(KEY_1, '5')
    await s.forgetNameSchemes()
    expect(s.nameScheme('swarm.eth')).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dir, 'name-schemes.json'), 'utf8'))).toEqual({})
    expect(new VerifierStore(dir).nameScheme('a.eth')).toBeUndefined()
    expect(s.saveNameScheme('swarm.eth', 'bzz')).toBe(true)
    await s.flush()
    expect(new VerifierStore(dir).nameScheme('swarm.eth')).toBe('bzz')
    await s.flush()
    expect(new VerifierStore(dir).ipnsSequences()).toEqual({ [KEY_1]: '5' })
  })

  it('forgets names that were never flushed, so no pending write brings them back', async () => {
    const { store: s, dir } = store()
    s.saveNameScheme('swarm.eth', 'bzz')
    await s.forgetNameSchemes()
    await s.flush()
    expect(new VerifierStore(dir).nameScheme('swarm.eth')).toBeUndefined()
  })

  it('reads a corrupt name-scheme file, or values no protocol serves, as empty', async () => {
    const { store: s, dir } = store()
    s.saveNameScheme('swarm.eth', 'bzz')
    await s.flush()
    writeFileSync(join(dir, 'name-schemes.json'), '{"a.eth":"gopher","b.eth":3,"c.com":"bzz"}')
    const again = new VerifierStore(dir)
    expect([again.nameScheme('a.eth'), again.nameScheme('b.eth'), again.nameScheme('c.com')]).toEqual([undefined, undefined, undefined])
    writeFileSync(join(dir, 'name-schemes.json'), '{nope')
    expect(new VerifierStore(dir).nameScheme('swarm.eth')).toBeUndefined()
  })

  it('writes nothing until the debounced flush fires, or flush is called directly', async () => {
    const { store: s, dir } = store()
    s.saveIpnsSequence(KEY_1, '1')
    // Read fresh from disk: nothing has landed yet, so a fresh instance sees none of it.
    expect(new VerifierStore(dir).ipnsSequences()).toEqual({})
    await s.flush()
    expect(new VerifierStore(dir).ipnsSequences()).toEqual({ [KEY_1]: '1' })
  })

  it('drops the least recently touched key past its cap', async () => {
    const { store: s, dir } = store()
    for (let i = 0; i < MAX_IPNS_KEYS; i++) s.saveIpnsSequence(await ipnsKey(`key-${String(i)}`), '1')
    s.saveIpnsSequence(await ipnsKey('key-0'), '2') // touched again: now the most recent, not the one that gets dropped
    s.saveIpnsSequence(await ipnsKey('one-more'), '1') // pushes the cap by one
    await s.flush()
    const kept = new VerifierStore(dir).ipnsSequences()
    expect(Object.keys(kept)).toHaveLength(MAX_IPNS_KEYS)
    expect(kept[await ipnsKey('key-0')]).toBe('2')
    expect(kept[await ipnsKey('key-1')]).toBeUndefined() // the actual least recently touched
    expect(kept[await ipnsKey('one-more')]).toBe('1')
  })

  it('reads a corrupt checkpoint file as empty', async () => {
    const { store: s, dir } = store()
    s.saveIpnsSequence(KEY_1, '1') // only to create the store's directory
    await s.flush()
    writeFileSync(join(dir, 'checkpoint.json'), '[]')
    expect(s.checkpoint()).toBeUndefined()
  })

  it('reads a corrupt IPNS-sequences file as empty, the first time it loads', async () => {
    const { store: s, dir } = store()
    s.saveIpnsSequence(KEY_1, '1')
    await s.flush()
    writeFileSync(join(dir, 'ipns-sequences.json'), '{not json')
    expect(new VerifierStore(dir).ipnsSequences()).toEqual({})
  })

  it('answers a later read from the floor already in memory, not a stale file', () => {
    const { store: s } = store()
    s.saveIpnsSequence(KEY_1, '5')
    // Nothing has been written yet (the debounce has not fired): a config
    // read right now, as a host restarting within that window would trigger,
    // must still see the floor just reported, not an empty or stale file.
    expect(s.ipnsSequences()).toEqual({ [KEY_1]: '5' })
    s.saveIpnsSequence(KEY_1, '9')
    expect(s.ipnsSequences()).toEqual({ [KEY_1]: '9' })
  })

  it('flushSync writes whatever is pending immediately, without awaiting anything', () => {
    const { store: s, dir } = store()
    s.saveIpnsSequence(KEY_1, '7')
    s.flushSync()
    expect(new VerifierStore(dir).ipnsSequences()).toEqual({ [KEY_1]: '7' })
  })
})

describe('the partition salt', () => {
  it('is 32 random bytes in hex, made once and the same for every later read, also from a new store on the same folder', () => {
    const { store: first, dir } = store()
    const salt = first.partitionSalt()
    expect(salt).toMatch(/^[0-9a-f]{64}$/)
    expect(first.partitionSalt()).toBe(salt)
    expect(new VerifierStore(dir).partitionSalt()).toBe(salt)
  })

  it('differs from one profile to another', () => {
    expect(store().store.partitionSalt()).not.toBe(store().store.partitionSalt())
  })

  it('is replaced by a rotation, which the next read and a new store both see', () => {
    const { store: kept, dir } = store()
    const before = kept.partitionSalt()
    const after = kept.rotatePartitionSalt()
    expect(after).toMatch(/^[0-9a-f]{64}$/)
    expect(after).not.toBe(before)
    expect(kept.partitionSalt()).toBe(after)
    expect(new VerifierStore(dir).partitionSalt()).toBe(after)
  })

  it('is made again, not trusted, when its file is damaged', () => {
    const { store: kept, dir } = store()
    kept.partitionSalt()
    writeFileSync(join(dir, 'ipfs-node-partition-salt.json'), '{"salt":"short"}')
    expect(kept.partitionSalt()).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('where the Swarm chunks are kept', () => {
  it('is the profile folder and the partition salt, the same salt the IPFS node keys its store with', () => {
    const { store: kept, dir } = store()
    expect(kept.swarmChunks()).toEqual({ dir, salt: kept.partitionSalt() })
  })

  it('is nothing, and no error, when the profile cannot hold a salt: the host then starts without it', () => {
    const { dir } = store()
    writeFileSync(dir, 'not a folder')
    expect(new VerifierStore(dir).swarmChunks()).toBeUndefined()
  })
})
