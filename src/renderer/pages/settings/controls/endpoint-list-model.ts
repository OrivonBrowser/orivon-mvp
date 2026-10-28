// The decisions of a list of Ethereum server addresses kept as the newline-separated text of a setting, apart from its DOM:
// what adding and removing one do, and how one is shown. An address may hold a key, so it is never drawn as typed.

import { displayEndpoint } from '../../../../protocols/verifier-host/light-client/endpoint-mask.js'
import { serverAddressProblem } from '../../../../protocols/verifier-host/light-client/server-address.js'
import type { ServerKind } from '../../../../protocols/verifier-host/light-client/server-address.js'

export const PROBLEM_SAVE = 'The list could not be saved. Try again.'

/** The addresses in a stored value, one a line, skipping blank lines. */
export function splitEndpoints (value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

export const joinEndpoints = (endpoints: readonly string[]): string => endpoints.join('\n')

/** How an address is drawn: its key hidden. */
export const shownEndpoint = (endpoint: string): string => displayEndpoint(endpoint)

/** The address as the network reads it, so a spelling or a letter's case is not another server. */
function sameAs (a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href
  } catch {
    return a === b
  }
}

export type AddOutcome =
  | { readonly kind: 'added', readonly endpoints: string[] }
  /** Already listed: nothing changes and nothing is said. */
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'full' }
  /** `problem` is a sentence for the person, and holds no part of what was typed. */
  | { readonly kind: 'invalid', readonly problem: string }

/** Adds the address in `text` after those listed, when the setting would take it. */
export function addEndpoint (endpoints: readonly string[], text: string, kind: ServerKind, max: number): AddOutcome {
  const typed = text.trim()
  const problem = serverAddressProblem(typed, kind)
  if (problem !== undefined) return { kind: 'invalid', problem }
  if (endpoints.some((listed) => sameAs(listed, typed))) return { kind: 'duplicate' }
  if (endpoints.length >= max) return { kind: 'full' }
  return { kind: 'added', endpoints: [...endpoints, typed] }
}

export function removeEndpoint (endpoints: readonly string[], index: number): string[] {
  return endpoints.filter((_, position) => position !== index)
}
