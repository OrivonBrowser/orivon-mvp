// A password a person can be offered, from the operating system's random
// source. Pure apart from that source, which a test replaces.
import { randomInt } from 'node:crypto'

// Characters that read as another one (0 O 1 l I) are left out, so a password
// copied by eye comes out right.
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGITS = '23456789'
const SYMBOLS = '-_.!'
const CLASSES = [LOWER, UPPER, DIGITS, SYMBOLS]
const ALL = CLASSES.join('')

export const PASSWORD_LENGTH = 20

/** Picks an integer in [0, max). Node's `randomInt` is uniform: no modulo bias. */
export type RandomBelow = (max: number) => number

/** `length` characters with at least one of each class; `random` is for tests. */
export function generatePassword (length: number = PASSWORD_LENGTH, random: RandomBelow = (max) => randomInt(max)): string {
  if (!Number.isInteger(length) || length < CLASSES.length || length > 128) throw new RangeError(`a password is ${String(CLASSES.length)} to 128 characters long`)
  const pick = (from: string): string => from.charAt(random(from.length))
  const chars = [...CLASSES.map(pick)]
  while (chars.length < length) chars.push(pick(ALL))
  // The guaranteed characters were placed first: shuffle so their positions carry no information.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = random(i + 1)
    const held = chars[i] as string
    chars[i] = chars[j] as string
    chars[j] = held
  }
  return chars.join('')
}
