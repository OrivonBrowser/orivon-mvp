import { describe, expect, it } from 'vitest'
import { unproxiedGateways } from '../proxy-check.js'

const A = 'https://a.gateway'
const B = 'https://b.gateway'

describe('unproxiedGateways', () => {
  it('keeps only the gateways that answer exactly DIRECT', async () => {
    const resolveProxy = async (url: string): Promise<string> => url === A ? 'DIRECT' : 'PROXY 127.0.0.1:8080'
    expect(await unproxiedGateways([A, B], resolveProxy)).toEqual([A])
  })

  it('tolerates surrounding whitespace in the answer', async () => {
    const resolveProxy = async (): Promise<string> => '  DIRECT  '
    expect(await unproxiedGateways([A], resolveProxy)).toEqual([A])
  })

  it('treats a thrown error as proxied, not unproxied', async () => {
    const resolveProxy = async (): Promise<string> => { throw new Error('no proxy service') }
    expect(await unproxiedGateways([A], resolveProxy)).toEqual([])
  })

  it('treats a check that never resolves as proxied, bounded by its own timeout', async () => {
    const resolveProxy = async (): Promise<string> => await new Promise(() => {})
    expect(await unproxiedGateways([A], resolveProxy)).toEqual([])
  })

  it('checks each gateway on its own, since a PAC script can answer differently per URL', async () => {
    const seen: string[] = []
    const resolveProxy = async (url: string): Promise<string> => { seen.push(url); return 'DIRECT' }
    await unproxiedGateways([A, B], resolveProxy)
    expect(seen.sort()).toEqual([A, B])
  })

  it('returns an empty list for an empty input, with no calls made', async () => {
    let calls = 0
    const resolveProxy = async (): Promise<string> => { calls++; return 'DIRECT' }
    expect(await unproxiedGateways([], resolveProxy)).toEqual([])
    expect(calls).toBe(0)
  })
})
