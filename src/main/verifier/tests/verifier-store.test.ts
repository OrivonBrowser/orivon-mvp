import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CID } from 'multiformats/cid'
import { identity } from 'multiformats/hashes/identity'
import { base36 } from 'multiformats/bases/base36'
import { MAX_IPNS_KEYS, VerifierStore } from '../verifier-store.js'

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

  it('reads a corrupt file as empty', async () => {
    const { store: s, dir } = store()
    s.saveIpnsSequence(KEY_1, '1')
    await s.flush()
    writeFileSync(join(dir, 'ipns-sequences.json'), '{not json')
    writeFileSync(join(dir, 'checkpoint.json'), '[]')
    expect(s.ipnsSequences()).toEqual({})
    expect(s.checkpoint()).toBeUndefined()
  })
})
