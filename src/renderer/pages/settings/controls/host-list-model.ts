// The decisions of a list of sites kept as the newline-separated text of a setting, apart from its DOM: what a
// typed site name becomes, and what adding and removing one do.

/** The most sites the settings hold; main's check says the same. */
export const MAX_HOSTS = 200

export const PROBLEM_HOST = 'Enter a site name such as example.com'
export const PROBLEM_FULL = `You can list up to ${String(MAX_HOSTS)} sites`
export const PROBLEM_SAVE = 'The list could not be saved. Try again.'
export const PLACEHOLDER_FULL = `You can list up to ${String(MAX_HOSTS)} sites`

/** A host name as main's check takes it: lowercase letters, digits, dots and hyphens. */
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/

/** The site name in `text`, or null: an address is cut down to its host, and a name in another script to its ASCII form. */
export function normaliseHost (text: string): string | null {
  const trimmed = text.trim()
  if (trimmed === '' || /\s/.test(trimmed)) return null
  try {
    const { hostname } = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    return HOST.test(hostname) && !hostname.includes('..') ? hostname : null
  } catch {
    return null
  }
}

/** The sites in a stored value, one a line, skipping blank lines. */
export function splitHosts (value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

export const joinHosts = (hosts: readonly string[]): string => hosts.join('\n')

/** The sites in what a person typed or pasted, separated by spaces, commas or line breaks, each once; empty when any part is not a site name. */
export function parseHostList (text: string): string[] {
  const parts = text.split(/[\s,;]+/).filter((part) => part !== '')
  const hosts: string[] = []
  for (const part of parts) {
    const host = normaliseHost(part)
    if (host === null) return []
    if (!hosts.includes(host)) hosts.push(host)
  }
  return hosts
}

export type AddOutcome =
  | { readonly kind: 'added', readonly hosts: string[] }
  /** Everything typed is listed already: nothing changes and nothing is said. */
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'full' }
  | { readonly kind: 'invalid' }

/** Adds the sites in `text` after those listed, in the order typed. */
export function addHost (hosts: readonly string[], text: string): AddOutcome {
  const typed = parseHostList(text)
  if (typed.length === 0) return { kind: 'invalid' }
  const fresh = typed.filter((host) => !hosts.includes(host))
  if (fresh.length === 0) return { kind: 'duplicate' }
  if (hosts.length + fresh.length > MAX_HOSTS) return { kind: 'full' }
  return { kind: 'added', hosts: [...hosts, ...fresh] }
}

export function removeHost (hosts: readonly string[], index: number): string[] {
  return hosts.filter((_, position) => position !== index)
}
