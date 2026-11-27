import { keccak256, stringToBytes } from 'viem'
import type { Address, Hex } from 'viem'

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

export const ZERO_WORD: Hex = `0x${'0'.repeat(64)}`

export function sameAddress (left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

/**
 * The keccak-256 of a text's UTF-8 bytes: what an indexed string of a log carries in place of the string. Never `toBytes`, which reads a
 * text that looks like hexadecimal (a contract's address, say) as the bytes it spells.
 */
export function hashOf (text: string): Hex {
  return keccak256(stringToBytes(text))
}
