import { concat, encodeFunctionData, getAddress, parseAbi, toFunctionSelector } from 'viem'
import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { keyOf } from '../name.js'
import { PROXY, REGISTRY, WRAPPER } from '../pins.js'
import { REGISTRY_CALLS, SETTERS, decodeRegistryCall } from '../registry-calls.js'

const KEY = keyOf('jsunblaze')
const OTHER = keyOf('aiagent')
const VALUE = '0xc452c1d588b1e9f01a272fee57ff9d29b22d163fbbb4fd8733f6e25a7dcbef34'
const PEER = getAddress(`0x${'ab'.repeat(20)}`)

const abi = parseAbi([
  'function setContent(bytes32,bytes32)', 'function setAddress(bytes32,address,bool)', 'function setSubRegistrar(bytes32,address)',
  'function reserve(bytes32)', 'function transfer(bytes32,address)', 'function disown(bytes32)', 'function owner(bytes32)', 'function disown(bytes32,address)'
])
const direct = (input: Hex): { to: string, input: Hex } => ({ to: REGISTRY, input })
const encode = (name: string, args: unknown[]): Hex => encodeFunctionData({ abi, functionName: name, args } as never)

/** What a call to each of the six looks like on chain, by the arguments each takes. */
const CALLS: [string, unknown[]][] = [
  ['setContent', [KEY, VALUE]],
  ['setAddress', [KEY, PEER, true]],
  ['setSubRegistrar', [KEY, PEER]],
  ['reserve', [KEY]],
  ['transfer', [KEY, PEER]],
  ['disown', [KEY]]
]

describe("the registry's selectors", () => {
  it("are the four bytes of each call's signature, as the contract's own code dispatches them", () => {
    expect(REGISTRY_CALLS.map(([fn, signature]) => [fn, toFunctionSelector(signature).slice(2)])).toEqual([
      ['setContent', 'c3d014d6'], ['setAddress', 'be99a980'], ['setSubRegistrar', '89a69c0e'], ['reserve', '432ced04'], ['transfer', '79ce9fac'], ['disown', 'd93e7573']
    ])
  })

  it('count three setters, and not the calls that start, move or end a name', () => {
    expect([...SETTERS].sort()).toEqual(['setAddress', 'setContent', 'setSubRegistrar'])
  })
})

describe('decodeRegistryCall', () => {
  it.each(CALLS)('reads a direct call of %s about the name', (fn, args) => {
    expect(decodeRegistryCall(direct(encode(fn, args)), KEY)).toEqual(fn === 'setContent' ? { fn, value: VALUE } : { fn })
  })

  it('gives the value a setContent wrote as lower-case hexadecimal, and takes the key in either case', () => {
    const upper = `0x${VALUE.slice(2).toUpperCase()}` as Hex
    const input = encode('setContent', [KEY, upper])
    expect(decodeRegistryCall(direct(input), `0x${KEY.slice(2).toUpperCase()}` as Hex)).toEqual({ fn: 'setContent', value: VALUE })
  })

  it("takes the registry's address in either case", () => {
    expect(decodeRegistryCall({ to: REGISTRY.toLowerCase(), input: encode('reserve', [KEY]) }, KEY)).toEqual({ fn: 'reserve' })
  })

  it('reads nothing of a transaction that is not to the registry: a contract call can do anything with the same input, a creation has no recipient', () => {
    const input = encode('setContent', [KEY, VALUE])
    for (const to of [WRAPPER, PROXY, PEER, null]) expect(decodeRegistryCall({ to, input }, KEY), String(to)).toBeNull()
  })

  it('reads nothing of a call about another name', () => {
    for (const [fn, args] of CALLS) expect(decodeRegistryCall(direct(encode(fn, [OTHER, ...args.slice(1)])), KEY), fn).toBeNull()
  })

  it('reads nothing of input shorter or longer than the call takes, so a call that would read zeros for the words it lacks is not taken for the full one', () => {
    for (const [fn, args] of CALLS) {
      const input = encode(fn, args)
      expect(decodeRegistryCall(direct(input.slice(0, -2) as Hex), KEY), `${fn} one byte short`).toBeNull()
      expect(decodeRegistryCall(direct(input.slice(0, 74) as Hex), KEY) === null, `${fn} cut after the name`).toBe(args.length > 1)
      expect(decodeRegistryCall(direct(concat([input, '0x00'])), KEY), `${fn} one byte over`).toBeNull()
      expect(decodeRegistryCall(direct(concat([input, `0x${'00'.repeat(32)}`])), KEY), `${fn} one word over`).toBeNull()
    }
  })

  it('reads nothing of empty input, a selector alone, a selector the registry does not have, or garbage', () => {
    expect(decodeRegistryCall(direct('0x'), KEY)).toBeNull()
    expect(decodeRegistryCall(direct('0xc3d014d6'), KEY)).toBeNull()
    expect(decodeRegistryCall(direct('0xc3d014'), KEY)).toBeNull()
    expect(decodeRegistryCall(direct(encode('owner', [KEY])), KEY)).toBeNull()
    expect(decodeRegistryCall(direct(encodeFunctionData({ abi, functionName: 'disown', args: [KEY, PEER] })), KEY)).toBeNull()
    const garbage = `0x${Array.from({ length: 68 }, (_, index) => ((index * 37) % 251).toString(16).padStart(2, '0')).join('')}` as Hex
    expect(decodeRegistryCall(direct(garbage), KEY)).toBeNull()
  })
})
