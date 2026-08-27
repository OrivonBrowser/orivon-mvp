// Reading one property off an object that arrived as untrusted JSON --
// consolidated out of four instances of the same pattern written separately
// in pin.ts (ownString, ownNumber, ownFiniteNumber) and update.ts
// (patternsFor) -- docs/development/code-guidelines.md Rule 3.
//
// Own-property read plus a type guard. Both halves matter for input that
// came from a publisher- or user-controlled document: a `__proto__` key
// would otherwise resolve through the prototype chain to something
// non-undefined, and returning it unchecked is a crash or a lie waiting to
// happen one layer up, inside a security decision.

/**
 * `value[key]`, but only if `key` is an OWN property of `value` and the
 * value there passes `guard` -- undefined otherwise, never a prototype-chain
 * hit and never an unchecked cast.
 */
export function ownProperty<T> (value: object, key: string, guard: (v: unknown) => v is T): T | undefined {
  if (!Object.hasOwn(value, key)) return undefined
  const v = (value as Record<string, unknown>)[key]
  return guard(v) ? v : undefined
}

export function isString (v: unknown): v is string {
  return typeof v === 'string'
}

export function isFiniteNumber (v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export function isArray (v: unknown): v is readonly unknown[] {
  return Array.isArray(v)
}
