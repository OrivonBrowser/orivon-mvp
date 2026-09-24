import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VerifierStore } from '../verifier-store.js'

const dirs: string[] = []
function store (): { store: VerifierStore, dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-verifier-store-'))
  dirs.push(dir)
  return { store: new VerifierStore(join(dir, 'verifier')), dir: join(dir, 'verifier') }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const root = (c: string): string => '0x' + c.repeat(64)

describe('VerifierStore', () => {
  it('reads nothing before anything is saved', () => {
    const { store: s } = store()
    expect(s.checkpoint()).toBeUndefined()
    expect(s.ipnsSequences()).toEqual({})
  })

  it('keeps a checkpoint across instances, and only ever a newer one', () => {
    const { store: s, dir } = store()
    s.saveCheckpoint({ root: root('a'), timestamp: 1_700_000_000 })
    s.saveCheckpoint({ root: root('b'), timestamp: 1_600_000_000 })
    expect(new VerifierStore(dir).checkpoint()).toEqual({ root: root('a'), timestamp: 1_700_000_000 })
    s.saveCheckpoint({ root: root('c'), timestamp: 1_800_000_000 })
    expect(s.checkpoint()?.root).toBe(root('c'))
  })

  it('refuses to save a malformed checkpoint', () => {
    const { store: s } = store()
    s.saveCheckpoint({ root: 'nope', timestamp: 1_700_000_000 })
    expect(s.checkpoint()).toBeUndefined()
  })

  it('keeps the highest IPNS sequence per key', () => {
    const { store: s, dir } = store()
    s.saveIpnsSequence('k1', '5')
    s.saveIpnsSequence('k1', '3')
    s.saveIpnsSequence('k2', '18446744073709551615')
    s.saveIpnsSequence('k3', 'x')
    expect(new VerifierStore(dir).ipnsSequences()).toEqual({ k1: '5', k2: '18446744073709551615' })
  })

  it('reads a corrupt file as empty', () => {
    const { store: s, dir } = store()
    s.saveIpnsSequence('k1', '1')
    writeFileSync(join(dir, 'ipns-sequences.json'), '{not json')
    writeFileSync(join(dir, 'checkpoint.json'), '[]')
    expect(s.ipnsSequences()).toEqual({})
    expect(s.checkpoint()).toBeUndefined()
  })
})
