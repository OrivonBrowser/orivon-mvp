import { describe, expect, it } from 'vitest'
import { decodeAbiParameters, decodeFunctionData, encodeErrorResult, encodeFunctionData, encodeFunctionResult, parseAbi, toHex } from 'viem'
import type { Hex } from 'viem'
import { namehash } from 'viem/ens'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { ResolutionError } from '../../resolution/records.js'
import { UNIVERSAL_RESOLVER, createEnsResolver } from '../resolver.js'
import type { CcipRequestParameters, Eip1193Provider } from '../resolver.js'

const universalResolverAbi = parseAbi([
  'function resolveWithGateways(bytes name, bytes data, string[] gateways) view returns (bytes result, address resolver)',
  'function resolveCallback(bytes response, bytes extraData) view returns (bytes result, address resolver)',
  'error ResolverNotFound(bytes name)',
  'error HttpError(uint16 status, string message)',
  'error ResolverError(bytes errorData)',
  'error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)'
])
const contenthashAbi = parseAbi(['function contenthash(bytes32 node) view returns (bytes)'])
const batchGatewayAbi = parseAbi(['function query((address sender, string[] urls, bytes data)[]) returns (bool[] failures, bytes[] responses)'])

const RESOLVER_ADDRESS = '0x231b0ee14048e9dccd1d247744d114a4eb5e8e63'
const FINALIZED = 20_000_000n
const cid = CID.createV1(0x70, await sha256.digest(new TextEncoder().encode('site')))
const IPFS_CONTENTHASH = toHex(new Uint8Array([0xe3, 0x01, ...cid.bytes]))

/** An execution revert, as a JSON-RPC provider reports one. */
function revert (data: Hex): Error {
  return Object.assign(new Error('execution reverted'), { code: 3, data })
}

interface Call { to: string, data: Hex, block: unknown }

function provider (answer: (call: Call) => Hex): Eip1193Provider & { calls: Call[], methods: string[] } {
  const calls: Call[] = []
  const methods: string[] = []
  return {
    calls,
    methods,
    async request ({ method, params }) {
      methods.push(method)
      if (method === 'eth_getBlockByNumber') return { number: toHex(FINALIZED), hash: '0x' + '1'.repeat(64) }
      if (method === 'eth_call') {
        const [tx, block] = params as [{ to: string, data: Hex }, unknown]
        const call = { to: tx.to, data: tx.data, block }
        calls.push(call)
        return answer(call)
      }
      throw new Error(`unexpected ${method}`)
    }
  }
}

function answering (contenthash: Hex): (call: Call) => Hex {
  const result = encodeFunctionResult({ abi: contenthashAbi, functionName: 'contenthash', result: contenthash })
  return () => encodeFunctionResult({ abi: universalResolverAbi, functionName: 'resolveWithGateways', result: [result, RESOLVER_ADDRESS] })
}

const noCcip = async (): Promise<Hex> => { throw new Error('no offchain lookup expected') }

describe('the ENS resolver', () => {
  it('asks the Universal Resolver for the contenthash at the finalized block, and decodes it', async () => {
    const p = provider(answering(IPFS_CONTENTHASH))
    const records = await createEnsResolver({ provider: p, ccipRequest: noCcip }).resolve('vitalik.eth')
    expect(records).toEqual([{ type: 'contenthash', pointer: { kind: 'ipfs', cid: cid.toString() }, provenance: { via: 'chain', block: 20_000_000, offchain: false } }])
    expect(p.calls).toHaveLength(1)
    expect(p.calls[0]?.to.toLowerCase()).toBe(UNIVERSAL_RESOLVER)
    expect(p.calls[0]?.block).toBe(toHex(FINALIZED))
    const { args } = decodeFunctionData({ abi: universalResolverAbi, data: p.calls[0]!.data })
    const inner = decodeFunctionData({ abi: contenthashAbi, data: args[1] as Hex })
    expect(inner.args[0]).toBe(namehash('vitalik.eth'))
  })

  it('returns no record for an empty contenthash', async () => {
    expect(await createEnsResolver({ provider: provider(answering('0x')), ccipRequest: noCcip }).resolve('vitalik.eth')).toEqual([])
  })

  it('refuses an invalid name before any request', async () => {
    const p = provider(answering(IPFS_CONTENTHASH))
    await expect(createEnsResolver({ provider: p, ccipRequest: noCcip }).resolve('Vitalik.eth')).rejects.toMatchObject({ failure: 'invalid-name' })
    expect(p.methods).toEqual([])
  })

  it('reports a name with no resolver as not found', async () => {
    const p = provider(() => { throw revert(encodeErrorResult({ abi: universalResolverAbi, errorName: 'ResolverNotFound', args: ['0x00'] })) })
    await expect(createEnsResolver({ provider: p, ccipRequest: noCcip }).resolve('nobody.eth')).rejects.toMatchObject({ failure: 'not-found' })
  })

  it('reports a failed offchain gateway as unavailable, never as a proven absence', async () => {
    const p = provider(() => { throw revert(encodeErrorResult({ abi: universalResolverAbi, errorName: 'HttpError', args: [500, 'down'] })) })
    await expect(createEnsResolver({ provider: p, ccipRequest: noCcip }).resolve('offchain.eth')).rejects.toMatchObject({ failure: 'unavailable' })
  })

  it("keeps the provider's own failure, such as a light client not yet synced", async () => {
    const p = provider(() => { throw new ResolutionError('not-synced', 'light client syncing') })
    await expect(createEnsResolver({ provider: p, ccipRequest: noCcip }).resolve('vitalik.eth')).rejects.toMatchObject({ failure: 'not-synced' })
  })

  it('reports any other provider failure as unavailable', async () => {
    const p = provider(() => { throw new Error('socket hang up') })
    await expect(createEnsResolver({ provider: p, ccipRequest: noCcip }).resolve('vitalik.eth')).rejects.toMatchObject({ failure: 'unavailable' })
  })

  it('runs a CCIP-Read lookup through the injected request function, then marks the record offchain', async () => {
    const gateway = 'https://gateway.example/{sender}/{data}.json'
    const query = { sender: RESOLVER_ADDRESS, urls: [gateway], data: '0xabcdef' } as const
    const callData = encodeFunctionData({ abi: batchGatewayAbi, functionName: 'query', args: [[query]] })
    const offchain = revert(encodeErrorResult({
      abi: universalResolverAbi,
      errorName: 'OffchainLookup',
      args: [UNIVERSAL_RESOLVER, ['x-batch-gateway:true'], callData, '0x12345678', '0x99']
    }))
    const final = answering(IPFS_CONTENTHASH)
    const p = provider((call) => {
      if (call.data.startsWith('0x12345678')) return final(call)
      throw offchain
    })
    const asked: CcipRequestParameters[] = []
    const ccipRequest = async (parameters: CcipRequestParameters): Promise<Hex> => {
      asked.push(parameters)
      return '0xfeed'
    }
    const records = await createEnsResolver({ provider: p, ccipRequest }).resolve('name.offchain.eth')
    expect(records[0]?.provenance).toEqual({ via: 'chain', block: 20_000_000, offchain: true })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.urls).toEqual([gateway])
    expect(asked[0]?.data).toBe('0xabcdef')
    // The gateway's answer goes back through a call at the same block, so the resolver contract checks it on proven state.
    expect(p.calls.map((c) => c.block)).toEqual([toHex(FINALIZED), toHex(FINALIZED)])
    const [response] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], `0x${p.calls[1]!.data.slice(10)}`)
    expect(response).toContain('feed')
  })

  it('keeps whatever kind the contenthash names', async () => {
    const swarm = toHex(new Uint8Array([0xe4, 0x01, 0x01, 0xfa]))
    const records = await createEnsResolver({ provider: provider(answering(swarm)), ccipRequest: noCcip }).resolve('swarm.eth')
    expect(records[0]?.pointer).toEqual({ kind: 'unsupported', protocol: 'swarm' })
  })
})
