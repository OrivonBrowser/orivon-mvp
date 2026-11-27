import { toFunctionSelector } from 'viem'
import type { Hex } from 'viem'
import type { Transaction } from './chain.js'
import { sameAddress } from './hex.js'
import { REGISTRY } from './pins.js'

// What a transaction did to a name in the registry. The registry's `Changed(name)` carries no data and is emitted by every call that
// touches a name, so the log alone cannot tell the holder setting a field of the name from the name changing hands. The transaction
// can: this reads a direct call to the registry by its selector. A call through any other contract (a Safe, a wallet that batches, a
// bundler) is not read: the light client gives no trace of what such a call did inside, and an unread call is never a setter.

export type RegistryFn = 'setContent' | 'setAddress' | 'setSubRegistrar' | 'reserve' | 'transfer' | 'disown'

/** A direct call of the registry about one name: `value` is the bytes32 a `setContent` wrote, as 0x and 64 lower-case hexadecimal digits. */
export type RegistryCall = { readonly fn: 'setContent', readonly value: string } | { readonly fn: Exclude<RegistryFn, 'setContent'> }

/**
 * The registry's calls that take a name as their first argument, with the signature each is selected by: the owner's setters of the three
 * fields of a name (the content, the address, the sub-registrar), and the three calls that start, move or end a name's ownership.
 */
export const REGISTRY_CALLS: readonly (readonly [RegistryFn, string])[] = Object.freeze([
  ['setContent', 'setContent(bytes32,bytes32)'],
  ['setAddress', 'setAddress(bytes32,address,bool)'],
  ['setSubRegistrar', 'setSubRegistrar(bytes32,address)'],
  ['reserve', 'reserve(bytes32)'],
  ['transfer', 'transfer(bytes32,address)'],
  ['disown', 'disown(bytes32)']
] as const)

/** The calls that set a field of a name its owner holds and leave the owner as it was: none of them changes who holds the name. */
export const SETTERS: ReadonlySet<string> = new Set(['setContent', 'setAddress', 'setSubRegistrar'])

/** Each call by its selector, with the 32-byte words its arguments take. */
const BY_SELECTOR: ReadonlyMap<string, { fn: RegistryFn, words: number }> = new Map(REGISTRY_CALLS.map(([fn, signature]) => [
  toFunctionSelector(signature),
  { fn, words: signature.slice(signature.indexOf('(') + 1, -1).split(',').length }
]))

/**
 * The call a transaction made to the registry about `key`, or null for anything else: a transaction to another address, a selector that
 * is none of the six, input of another length than the call's (a call that would read missing words as zeros is not read as the call it
 * resembles), or a first argument that is another name.
 * @param key the name's registry key, 0x and 64 hexadecimal digits
 */
export function decodeRegistryCall (tx: Pick<Transaction, 'to' | 'input'>, key: Hex): RegistryCall | null {
  if (tx.to === null || !sameAddress(tx.to, REGISTRY)) return null
  const input = tx.input.toLowerCase()
  const bytes = (input.length - 2) / 2
  const known = bytes < 4 ? undefined : BY_SELECTOR.get(input.slice(0, 10))
  if (known === undefined || bytes !== 4 + 32 * known.words) return null
  if (`0x${input.slice(10, 74)}` !== key.toLowerCase()) return null
  return known.fn === 'setContent' ? { fn: 'setContent', value: `0x${input.slice(74, 138)}` } : { fn: known.fn }
}
