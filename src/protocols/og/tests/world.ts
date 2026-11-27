import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, getAddress, parseAbi, toFunctionSelector } from 'viem'
import type { Address, Hex } from 'viem'
import type { Eip1193Provider } from '../../ens/resolver.js'
import { CENSUS_FORMAT } from '../census.js'
import type { Census, NameEntry } from '../census.js'
import { ChainError, eip1193Chain } from '../chain.js'
import type { Chain, LogFilter, Transaction } from '../chain.js'
import { idTopic, nameLogsOf } from '../freshness.js'
import type { NameLogs } from '../freshness.js'
import { ZERO_ADDRESS, ZERO_WORD, sameAddress } from '../hex.js'
import { keyOf } from '../name.js'
import { IMPLEMENTATION, IMPLEMENTATION_SLOT, MULTICALL3, PROXY, REGISTRY, TOPICS, UPGRADES, WRAPPER } from '../pins.js'
import { decodeRegistryCall } from '../registry-calls.js'
import type { Place, Vector } from './vectors.js'

// A Chain over a table of names and a list of logs, behind a real EIP-1193 provider: the registry, the wrapper and the resolver proxy
// answer the reads the resolver makes through one `aggregate3`, `eth_getLogs` answers by address, topics and range, and the proxy's
// implementation slot holds one address. Every read the provider is asked is kept, so a test can say which block it was made at and
// how many log queries a lookup took, and which transactions it read.
//
// A log's transaction is the world's too. A registry `Changed` log may carry the transaction behind it (`call`); one that does not is
// read as `transfer(name, 0x...dEaD)`, a change of holder, which is what each live name's logs is (a reserve, a transfer, a disown or
// the wrapper's unwrap, read from the chain).

export interface NameState {
  registryOwner: string
  nameToId: string
  idToName: string
  ownerOf: string | null
  controller: string | null
  /** The registry's `content` slot; all zeros (the default) for none. */
  registryContent?: string
  values: Record<string, string>
}

/** The transaction behind a log, as a node would give it: `to` is the registry unless said, `input` is hexadecimal. */
export interface WorldCall { to?: string, from?: string, input: string }
export interface WorldLog { address: string, blockNumber: number, logIndex: number, topics: string[], call?: WorldCall }
export interface World {
  head: number
  names: Record<string, NameState>
  logs: WorldLog[]
  implementation: string
}
export interface Faults {
  /** An error for a `getLogs` the node should fail, or undefined to answer it. */
  logs?: (filter: LogFilter) => ChainError | undefined
  /** What a node that trimmed the leading zeros of a storage value would answer. */
  trimSlot?: boolean
  /** A node that returns the logs of every address in the range, whatever address the query named. */
  anyAddress?: boolean
  /** An error for a transaction whose block the node should refuse, or undefined to answer it. */
  transactionAt?: (block: number) => ChainError | undefined
  /** What a node answers for a transaction by hash, in place of the world's: null for one it does not have, or an error. */
  transaction?: (hash: string) => Transaction | null | Promise<Transaction | null>
}

export const ADDRESS_OF: Record<Place, string> = { registry: REGISTRY, proxy: PROXY, wrapper: WRAPPER }
const DEAD = '0x000000000000000000000000000000000000dEaD'
const FREE: NameState = { registryOwner: ZERO_ADDRESS, nameToId: '0', idToName: ZERO_WORD, ownerOf: null, controller: ZERO_ADDRESS, values: {} }

const multicallAbi = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)'])
const registryAbi = parseAbi(['function owner(bytes32) view returns (address)', 'function content(bytes32) view returns (bytes32)', 'function transfer(bytes32,address)'])
const wrapperAbi = parseAbi(['function nameToId(bytes32) view returns (uint256)', 'function idToName(uint256) view returns (bytes32)', 'function ownerOf(uint256) view returns (address)'])
const proxyAbi = parseAbi(['function controller(bytes32) view returns (address)', 'function getTextRecord(bytes32, string) view returns (string)'])

/** The hash of the transaction behind a log: one transaction for each place in a block, as the world makes them. */
export const transactionHashOf = (log: { blockNumber: number, logIndex: number }): string => `0x${log.blockNumber.toString(16).padStart(48, '0')}${log.logIndex.toString(16).padStart(16, '0')}`

/** The first block of a world whose blocks were spread: after the resolver proxy's creation, so a census can be cut over it. */
export const FIRST_BLOCK = 16_000_000

/**
 * The world of one name at one block: the state and the logs of a vector. With `spread` its blocks are moved to `FIRST_BLOCK` and a
 * multiple of `spread` after it, in the same order: a live name's history is millions of blocks long, and what a test is after is the
 * order of its logs. `first` puts the first of them elsewhere than `FIRST_BLOCK`, for a name whose logs must lie past a block the census tool reads from.
 */
export function worldOf (vector: Vector, options: { spread?: number, head?: number, first?: number } = {}): World {
  const blocks = [...new Set(vector.logs.map((log) => log[1]))].sort((a, b) => a - b)
  const moved = (block: number): number => options.spread === undefined ? block : (options.first ?? FIRST_BLOCK) + blocks.indexOf(block) * options.spread
  const logs = vector.logs.map(([place, blockNumber, logIndex, topics, call]): WorldLog => ({ address: ADDRESS_OF[place], blockNumber: moved(blockNumber), logIndex, topics, ...(call === undefined ? {} : { call }) }))
  const head = options.head ?? Math.max(FIRST_BLOCK, ...logs.map((log) => log.blockNumber)) + 500
  return { head, names: { [vector.label]: { ...vector.state } }, logs, implementation: IMPLEMENTATION }
}

export interface Asked {
  logs: LogFilter[]
  calls: { to: string, block: number }[]
  blocks: unknown[]
  storage: { address: string, block: number }[]
  transactions: string[]
}

const hex = (value: number): Hex => `0x${value.toString(16)}`

/** The raw transaction a node gives for a log of the world. */
function rawTransaction (log: WorldLog, hash: string): Record<string, unknown> {
  const input = log.call?.input ?? encodeFunctionData({ abi: registryAbi, functionName: 'transfer', args: [log.topics[1] as Hex, DEAD] })
  return { hash: hash.toLowerCase(), blockNumber: hex(log.blockNumber), from: log.call?.from ?? ZERO_ADDRESS, to: log.call?.to ?? REGISTRY, input: input.startsWith('0x') ? input : `0x${input}` }
}

export function fakeProvider (world: World, options: { maxSpan?: number, faults?: Faults } = {}): Eip1193Provider & { asked: Asked } {
  const { maxSpan = 1024, faults = {} } = options
  const asked: Asked = { logs: [], calls: [], blocks: [], storage: [], transactions: [] }
  const stateOf = (key: string): NameState => {
    const found = Object.entries(world.names).find(([label]) => keyOf(label) === key.toLowerCase())
    return found?.[1] ?? FREE
  }
  const stateOfId = (id: bigint): NameState | undefined => Object.values(world.names).find((state) => BigInt(state.nameToId) === id && id !== 0n)

  function answer (to: string, data: Hex): Hex | null {
    const selector = data.slice(0, 10)
    const word = (index: number): Hex => `0x${data.slice(10 + index * 64, 74 + index * 64)}`
    const is = (target: string, abi: ReturnType<typeof parseAbi>, name: string): boolean => sameAddress(to, target) && selector === toFunctionSelector((abi.find((item) => item.type === 'function' && item.name === name) as Parameters<typeof toFunctionSelector>[0]))
    if (is(REGISTRY, registryAbi, 'owner')) return encodeAbiParameters([{ type: 'address' }], [stateOf(word(0)).registryOwner as Address])
    if (is(WRAPPER, wrapperAbi, 'nameToId')) return encodeAbiParameters([{ type: 'uint256' }], [BigInt(stateOf(word(0)).nameToId)])
    if (is(PROXY, proxyAbi, 'controller')) {
      const controller = stateOf(word(0)).controller
      return controller === null ? null : encodeAbiParameters([{ type: 'address' }], [controller as Address])
    }
    if (is(REGISTRY, registryAbi, 'content')) return stateOf(word(0)).registryContent as Hex ?? ZERO_WORD
    if (is(PROXY, proxyAbi, 'getTextRecord')) {
      const { args } = decodeFunctionData({ abi: proxyAbi, data })
      const [key, name] = args as [Hex, string]
      return encodeAbiParameters([{ type: 'string' }], [stateOf(key).values[name] ?? ''])
    }
    if (is(WRAPPER, wrapperAbi, 'idToName')) return (stateOfId(BigInt(word(0)))?.idToName ?? ZERO_WORD) as Hex
    if (is(WRAPPER, wrapperAbi, 'ownerOf')) {
      const holder = stateOfId(BigInt(word(0)))?.ownerOf
      return holder === undefined || holder === null ? null : encodeAbiParameters([{ type: 'address' }], [holder as Address])
    }
    return null
  }

  return {
    asked,
    async request ({ method, params }) {
      const p = (params ?? []) as unknown[]
      switch (method) {
        case 'eth_getBlockByNumber': {
          asked.blocks.push(p[0])
          if (p[0] !== 'latest') throw new ChainError('invalid', 'only the newest verified block is asked for')
          return { number: hex(world.head), hash: `0x${world.head.toString(16).padStart(64, '0')}` }
        }
        case 'eth_call': {
          const [tx, block] = p as [{ to: string, data: Hex }, string]
          asked.calls.push({ to: tx.to, block: Number(BigInt(block)) })
          if (!sameAddress(tx.to, MULTICALL3)) {
            const direct = answer(tx.to, tx.data)
            if (direct === null) throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' })
            return direct
          }
          const { args } = decodeFunctionData({ abi: multicallAbi, data: tx.data })
          const calls = args[0] as readonly { target: string, callData: Hex }[]
          const results = calls.map(({ target, callData }) => {
            const out = answer(target, callData)
            return { success: out !== null, returnData: out ?? '0x' as Hex }
          })
          return encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: results })
        }
        case 'eth_getLogs': {
          const [raw] = p as [{ fromBlock: string, toBlock: string, address?: string[], topics?: (string | null)[] }]
          const filter: LogFilter = { fromBlock: Number(BigInt(raw.fromBlock)), toBlock: Number(BigInt(raw.toBlock)), ...(raw.address === undefined ? {} : { address: raw.address as Address[] }), ...(raw.topics === undefined ? {} : { topics: raw.topics }) }
          asked.logs.push(filter)
          if (filter.toBlock - filter.fromBlock + 1 > maxSpan) throw new ChainError('limit', 'the range is wider than the node allows')
          const failure = faults.logs?.(filter)
          if (failure !== undefined) throw failure
          const addresses = faults.anyAddress === true ? [] : [raw.address ?? []].flat()
          return world.logs
            .filter((log) => log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock && (addresses.length === 0 || addresses.some((address) => sameAddress(address, log.address))))
            .filter((log) => (filter.topics ?? []).every((topic, index) => topic === null || topic.toLowerCase() === (log.topics[index] ?? '').toLowerCase()))
            .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
            .map((log) => ({ address: getAddress(log.address), topics: log.topics, data: '0x', blockNumber: hex(log.blockNumber), transactionHash: transactionHashOf(log), logIndex: hex(log.logIndex), removed: false }))
        }
        case 'eth_getTransactionByHash': {
          const hash = String(p[0])
          asked.transactions.push(hash)
          const block = world.logs.find((one) => transactionHashOf(one) === hash.toLowerCase())?.blockNumber
          const refused = block === undefined ? undefined : faults.transactionAt?.(block)
          if (refused !== undefined) throw refused
          if (faults.transaction !== undefined) {
            const found = await faults.transaction(hash)
            return found === null ? null : { hash: found.hash, blockNumber: found.blockNumber === null ? null : hex(found.blockNumber), from: found.from, to: found.to, input: found.input }
          }
          const log = world.logs.find((one) => transactionHashOf(one) === hash.toLowerCase())
          return log === undefined ? null : rawTransaction(log, hash)
        }
        case 'eth_getStorageAt': {
          const [address, slot, block] = p as [string, string, string]
          asked.storage.push({ address, block: Number(BigInt(block)) })
          if (!sameAddress(address, PROXY) || slot !== IMPLEMENTATION_SLOT) return `0x${'0'.repeat(64)}`
          const word = world.implementation.slice(2).toLowerCase().padStart(64, '0')
          return faults.trimSlot === true ? `0x${word.replace(/^0+/, '')}` : `0x${word}`
        }
        default: throw new Error(`unexpected ${method}`)
      }
    }
  }
}

/** A Chain over `fakeProvider`, so a test reads through the adapter the resolver uses. */
export function fakeChain (world: World, options: { maxSpan?: number, faults?: Faults } = {}): { chain: Chain, asked: Asked, world: World, provider: Eip1193Provider } {
  const provider = fakeProvider(world, options)
  return { chain: eip1193Chain(provider), asked: provider.asked, world, provider }
}

/** A log of the resolver proxy that says the implementation changed, at a block. */
export const upgradedLog = (blockNumber: number, implementation = `0x${'ab'.repeat(20)}`, logIndex = 0): WorldLog => ({ address: PROXY, blockNumber, logIndex, topics: [TOPICS.upgraded, `0x${'0'.repeat(24)}${implementation.slice(2).toLowerCase()}`] })

/** The proxy's upgrades as the chain logged them (`UPGRADES`): what a world holds for a census to be cut over it. */
export const pinnedUpgradeLogs = (): WorldLog[] => UPGRADES.map((upgrade) => upgradedLog(upgrade.block, upgrade.implementation, upgrade.logIndex))

/**
 * The logs of one name as the freshness rule reads them: the registry's and the resolver's that carry its key, and the wrapper's transfers of
 * its token. Each registry `Changed` log carries the call its transaction made, as a resolver that read every transaction would give it.
 */
export function nameLogs (world: World, label: string): NameLogs {
  const key = keyOf(label)
  const callOf = (log: WorldLog): { call?: ReturnType<typeof decodeRegistryCall> } => {
    if (!sameAddress(log.address, REGISTRY) || log.topics[0] !== TOPICS.changed) return {}
    const tx = rawTransaction(log, transactionHashOf(log)) as { to: string, input: Hex }
    return { call: decodeRegistryCall(tx, key) }
  }
  const named = world.logs
    .filter((log) => (sameAddress(log.address, REGISTRY) || sameAddress(log.address, PROXY)) && sameAddress(log.topics[1] ?? '', key))
    .map((log) => ({ blockNumber: log.blockNumber, logIndex: log.logIndex, topics: log.topics, ...callOf(log) }))
  const token = BigInt(world.names[label]?.nameToId ?? 0)
  const moved = token === 0n ? [] : world.logs.filter((log) => sameAddress(log.address, WRAPPER) && sameAddress(log.topics[3] ?? '', idTopic(token))).map((log) => ({ blockNumber: log.blockNumber, logIndex: log.logIndex, topics: log.topics }))
  return nameLogsOf(named, moved)
}

/** A census cut at `block`, listing the pinned upgrades and the names given. */
export const censusAt = (block: number, names: Record<string, NameEntry> = {}): Census => ({ format: CENSUS_FORMAT, block, blockHash: ZERO_WORD, implementation: IMPLEMENTATION, upgrades: [...UPGRADES], names })
