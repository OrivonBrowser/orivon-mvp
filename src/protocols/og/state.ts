import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'
import type { Address, Hex } from 'viem'
import { ChainError } from './chain.js'
import type { Chain } from './chain.js'
import type { NameReads } from './freshness.js'
import { ZERO_ADDRESS, sameAddress } from './hex.js'
import { MULTICALL3, PROXY, REGISTRY, TEXT_KEYS, WRAPPER } from './pins.js'

// What a name's contracts say at one block, read together: the block everything else is pinned to, and the registry (its owner and
// its own `content` slot), wrapper and resolver state of one name in as few calls as the dependencies allow (one `aggregate3`, then
// one more for a wrapped name's token). A call that fails is the contract's answer, never the node's: an owner that cannot be read
// is a name that is not there, and a record that cannot be read is a record that is not there. Only a node that cannot be asked throws.

/** Blocks behind the newest that no reorganisation reaches (two epochs): what a provider that names no finalised block close enough is taken to have settled. */
export const FINALITY_BLOCKS = 64

const multicallAbi = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)'])
const registryAbi = parseAbi(['function owner(bytes32) view returns (address)', 'function content(bytes32) view returns (bytes32)'])
const wrapperAbi = parseAbi(['function nameToId(bytes32) view returns (uint256)', 'function idToName(uint256) view returns (bytes32)', 'function ownerOf(uint256) view returns (address)'])
const proxyAbi = parseAbi(['function controller(bytes32) view returns (address)', 'function getTextRecord(bytes32, string) view returns (string)'])

/**
 * The block every read of one lookup is made at, and the highest block whose logs no reorganisation can still change. The block is the
 * newest the provider has verified, as the ENS resolver reads: a finalised block lags the head by about 80 blocks, and the execution
 * servers prove state only for recent blocks, so a read there fails whenever finality lags past their window. What that trades away is
 * resistance to a reorganisation of the last few blocks, so `final` stays 64 blocks (two epochs) behind: windows of logs are kept only up to it.
 */
export async function pinBlocks (chain: Chain): Promise<{ block: number, final: number }> {
  const { number } = await chain.latest()
  return { block: number, final: Math.max(0, number - FINALITY_BLOCKS) }
}

/** The decoded value of one call of a batch, or null when the call failed or its answer does not decode. */
function valueOf<T> (data: Hex | null, read: (data: Hex) => T): T | null {
  if (data === null) return null
  try {
    return read(data)
  } catch {
    return null
  }
}

const single = <T>(type: string) => (data: Hex): T => decodeAbiParameters([{ type }], data)[0] as T

/** Calls in one `aggregate3` of Multicall3 at one block, each allowed to fail on its own: the returned data of a call that succeeded, null for one that reverted. */
export async function readTogether (chain: Chain, calls: readonly { to: Address, data: Hex }[], block: number): Promise<(Hex | null)[]> {
  const batch = encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [calls.map((call) => ({ target: call.to, allowFailure: true, callData: call.data }))] })
  const { data } = await chain.call(MULTICALL3, batch, block)
  let results: readonly { success: boolean, returnData: Hex }[]
  try {
    if (data === null) throw new Error('Multicall3 reverted')
    results = decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', data })
  } catch (error) {
    throw new ChainError('badAnswer', 'Multicall3 did not answer the batch', { cause: error })
  }
  if (results.length !== calls.length) throw new ChainError('badAnswer', `Multicall3 answered ${String(results.length)} of ${String(calls.length)} calls`)
  return results.map(({ success, returnData }) => success ? returnData : null)
}

/**
 * The state of one name at `block`.
 * @param key the name's registry key (`keyOf`)
 * @param keys the text keys to read: those an answer lists, unless the census tool asks for more
 * @returns a registry owner of zero when the owner could not be read: such a name is not there
 */
export async function readName (chain: Chain, key: Hex, block: number, keys: readonly string[] = TEXT_KEYS.map(([text]) => text)): Promise<NameReads> {
  const [ownerData, idData, controllerData, contentData, ...textData] = await readTogether(chain, [
    { to: REGISTRY, data: encodeFunctionData({ abi: registryAbi, functionName: 'owner', args: [key] }) },
    { to: WRAPPER, data: encodeFunctionData({ abi: wrapperAbi, functionName: 'nameToId', args: [key] }) },
    { to: PROXY, data: encodeFunctionData({ abi: proxyAbi, functionName: 'controller', args: [key] }) },
    { to: REGISTRY, data: encodeFunctionData({ abi: registryAbi, functionName: 'content', args: [key] }) },
    ...keys.map((text) => ({ to: PROXY, data: encodeFunctionData({ abi: proxyAbi, functionName: 'getTextRecord', args: [key, text] }) }))
  ], block)
  const registryOwner = valueOf(ownerData ?? null, single<string>('address')) ?? ZERO_ADDRESS
  const nameToId = valueOf(idData ?? null, single<bigint>('uint256')) ?? 0n
  let idToName: string | null = null
  let ownerOf: string | null = null
  if (sameAddress(registryOwner, WRAPPER) && nameToId !== 0n) {
    const [nameData, holderData] = await readTogether(chain, [
      { to: WRAPPER, data: encodeFunctionData({ abi: wrapperAbi, functionName: 'idToName', args: [nameToId] }) },
      { to: WRAPPER, data: encodeFunctionData({ abi: wrapperAbi, functionName: 'ownerOf', args: [nameToId] }) }
    ], block)
    idToName = valueOf(nameData ?? null, single<string>('bytes32'))
    ownerOf = valueOf(holderData ?? null, single<string>('address'))
  }
  return {
    registryOwner,
    nameToId,
    idToName,
    ownerOf,
    controller: valueOf(controllerData ?? null, single<string>('address')),
    registryContent: valueOf(contentData ?? null, single<string>('bytes32')),
    values: Object.fromEntries(keys.map((text, index) => [text, valueOf(textData[index] ?? null, single<string>('string'))]))
  }
}
