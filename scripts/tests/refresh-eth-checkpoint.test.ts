import { describe, expect, it } from 'vitest'
import { agreedCheckpoint } from '../refresh-eth-checkpoint.mjs'

const ROOT = '0x' + 'a'.repeat(64)
const OTHER = '0x' + 'b'.repeat(64)

function beacon (answers: Record<string, { root: string, epoch?: string, slot?: string }>): (url: string) => Promise<unknown> {
  return async (url) => {
    const api = Object.keys(answers).find((a) => url.startsWith(a))
    if (api === undefined) throw new Error(`unexpected ${url}`)
    const answer = answers[api]!
    if (url.endsWith('/finality_checkpoints')) return { data: { finalized: { epoch: answer.epoch ?? '477676', root: answer.root } } }
    if (url.includes('/headers/')) return { data: { header: { message: { slot: answer.slot ?? '15285632' } } } }
    throw new Error(`unexpected ${url}`)
  }
}

describe('agreedCheckpoint', () => {
  it('returns the checkpoint and its slot time when every API agrees', async () => {
    const checkpoint = await agreedCheckpoint(beacon({ 'https://a': { root: ROOT }, 'https://b': { root: ROOT } }), ['https://a', 'https://b'])
    expect(checkpoint).toEqual({ root: ROOT, slot: 15_285_632, timestamp: 1_606_824_023 + 15_285_632 * 12, agreedBy: ['https://a', 'https://b'] })
  })

  it('refuses when the APIs disagree on the root or the epoch, never choosing one', async () => {
    await expect(agreedCheckpoint(beacon({ 'https://a': { root: ROOT }, 'https://b': { root: OTHER } }), ['https://a', 'https://b'])).rejects.toThrow(/disagree/)
    await expect(agreedCheckpoint(beacon({ 'https://a': { root: ROOT }, 'https://b': { root: ROOT, epoch: '477677' } }), ['https://a', 'https://b'])).rejects.toThrow(/disagree/)
  })

  it('refuses when they disagree on the slot', async () => {
    await expect(agreedCheckpoint(beacon({ 'https://a': { root: ROOT }, 'https://b': { root: ROOT, slot: '1' } }), ['https://a', 'https://b'])).rejects.toThrow(/slot/)
  })

  it('needs two APIs at least', async () => {
    await expect(agreedCheckpoint(beacon({ 'https://a': { root: ROOT } }), ['https://a'])).rejects.toThrow(/two/)
  })

  it('refuses a malformed root', async () => {
    await expect(agreedCheckpoint(beacon({ 'https://a': { root: 'x' }, 'https://b': { root: 'x' } }), ['https://a', 'https://b'])).rejects.toThrow(/no finalized checkpoint/)
  })
})
