// What an extension may ask for later, what it holds, and the words a person
// reads for the difference. Pure: the decisions behind chrome.permissions
// (permissions-api.ts asks and stores, this file only classifies).
import { hostWords } from '../../broker/policy/extension-permission-words.js'
import { isHostPatternLike, permissionLine } from '../../broker/policy/extension-manifest.js'
import { isStrippedPermissionName } from './extension-permission-check.js'

export interface PermissionSet {
  readonly permissions: readonly string[]
  readonly origins: readonly string[]
}

type Manifest = Readonly<Record<string, unknown>>

export const EMPTY_SET: PermissionSet = Object.freeze({ permissions: [], origins: [] })

function strings (value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function unique (items: readonly string[]): string[] {
  return [...new Set(items)]
}

/** The manifest's own lists: API names and host patterns in separate sets, MV2's mixed arrays split. */
function split (names: readonly string[], hosts: readonly string[]): PermissionSet {
  return {
    permissions: unique(names.filter((item) => !isHostPatternLike(item))),
    origins: unique([...hosts, ...names.filter(isHostPatternLike)])
  }
}

/** What the loaded manifest asks for outright, granted items included. */
function loadedRequired (manifest: Manifest): PermissionSet {
  return split(strings(manifest['permissions']), strings(manifest['host_permissions']))
}

/** What the manifest may ask for at runtime. A name Orivon never grants is left out. */
export function declaredOptional (manifest: Manifest): PermissionSet {
  const set = split(strings(manifest['optional_permissions']), strings(manifest['optional_host_permissions']))
  return { permissions: set.permissions.filter((name) => !isStrippedPermissionName(name)), origins: set.origins }
}

function subtract (from: readonly string[], remove: readonly string[]): string[] {
  const gone = new Set(remove)
  return from.filter((item) => !gone.has(item))
}

/** What the manifest requires with the person's grants taken out, for a manifest the grants were merged into. */
export function requiredOf (manifest: Manifest, granted: PermissionSet): PermissionSet {
  const required = loadedRequired(manifest)
  return { permissions: subtract(required.permissions, granted.permissions), origins: subtract(required.origins, granted.origins) }
}

/** Everything held now: the manifest's required items and the grants. */
export function heldSet (manifest: Manifest, granted: PermissionSet): PermissionSet {
  const required = loadedRequired(manifest)
  return {
    permissions: unique([...required.permissions, ...granted.permissions]),
    origins: unique([...required.origins, ...granted.origins])
  }
}

interface ParsedPattern { readonly all: boolean, readonly scheme: string, readonly host: string, readonly path: string }

function parsePattern (pattern: string): ParsedPattern | undefined {
  if (pattern === '<all_urls>') return { all: true, scheme: '*', host: '*', path: '/*' }
  const match = /^(\*|[a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]*)(\/.*)$/.exec(pattern)
  if (match === null) return undefined
  return { all: false, scheme: match[1] ?? '', host: (match[2] ?? '').toLowerCase(), path: match[3] ?? '' }
}

function schemeCovers (outer: ParsedPattern, inner: ParsedPattern): boolean {
  if (outer.all) return inner.scheme !== 'file'
  if (outer.scheme === inner.scheme) return true
  return outer.scheme === '*' && (inner.scheme === 'http' || inner.scheme === 'https')
}

function hostCovers (outer: string, inner: string): boolean {
  if (outer === '*' || outer === inner) return true
  if (!outer.startsWith('*.')) return false
  const suffix = outer.slice(2)
  const bare = inner.startsWith('*.') ? inner.slice(2) : inner
  return bare === suffix || bare.endsWith(`.${suffix}`)
}

/** A path glob covers another when they are equal or it is a plain prefix followed by one trailing `*`. */
function pathCovers (outer: string, inner: string): boolean {
  if (outer === '/*' || outer === inner) return true
  const prefix = outer.slice(0, -1)
  return outer.endsWith('*') && !prefix.includes('*') && inner.startsWith(prefix)
}

/** True when every URL `inner` matches, `outer` matches too. Conservative: a pair this cannot prove is not covered. */
export function patternCovers (outer: string, inner: string): boolean {
  const a = parsePattern(outer)
  const b = parsePattern(inner)
  if (a === undefined || b === undefined) return false
  if (a.scheme === 'file' || b.scheme === 'file') return outer === inner
  if (b.all) return a.all
  return schemeCovers(a, b) && hostCovers(a.host, b.host) && pathCovers(a.path, b.path)
}

function covered (patterns: readonly string[], pattern: string): boolean {
  return patterns.some((candidate) => patternCovers(candidate, pattern))
}

export interface PermissionRequest {
  readonly permissions: readonly string[]
  readonly origins: readonly string[]
}

export type RequestClass =
  | { readonly kind: 'held' }
  | { readonly kind: 'never', readonly item: string }
  | { readonly kind: 'undeclared', readonly item: string }
  | { readonly kind: 'ask', readonly permissions: readonly string[], readonly origins: readonly string[] }

/** Where `request` stands for an extension whose manifest is `manifest` and whose grants are `granted`:
 * everything already held, something that may never be asked for, something undeclared, or what to ask. */
export function classifyRequest (manifest: Manifest, granted: PermissionSet, request: PermissionRequest): RequestClass {
  const held = heldSet(manifest, granted)
  const optional = declaredOptional(manifest)
  const permissions: string[] = []
  const origins: string[] = []
  for (const name of request.permissions) {
    if (isHostPatternLike(name)) return { kind: 'undeclared', item: name }
    if (held.permissions.includes(name)) continue
    if (isStrippedPermissionName(name)) return { kind: 'never', item: name }
    if (!optional.permissions.includes(name)) return { kind: 'undeclared', item: name }
    permissions.push(name)
  }
  for (const origin of request.origins) {
    if (!isHostPatternLike(origin) || parsePattern(origin) === undefined || origin.startsWith('file:')) return { kind: 'undeclared', item: origin }
    if (covered(held.origins, origin)) continue
    if (!covered(optional.origins, origin)) return { kind: 'undeclared', item: origin }
    origins.push(origin)
  }
  if (permissions.length === 0 && origins.length === 0) return { kind: 'held' }
  return { kind: 'ask', permissions: unique(permissions), origins: unique(origins) }
}

/** One line of the prompt: plain words, or the bare name of a permission that has none. */
export type PromptLine = { readonly words: string } | { readonly name: string }

export function promptLines (ask: PermissionRequest): readonly PromptLine[] {
  const lines: PromptLine[] = []
  const seen = new Set<string>()
  const add = (line: PromptLine, key: string): void => {
    if (!seen.has(key)) { seen.add(key); lines.push(line) }
  }
  for (const name of ask.permissions) {
    const words = permissionLine(name)
    add(words === undefined ? { name } : { words }, words ?? `name:${name}`)
  }
  for (const origin of ask.origins) add({ words: hostWords(origin) }, hostWords(origin))
  return lines
}

export function mergeGranted (granted: PermissionSet, add: PermissionRequest): PermissionSet {
  return { permissions: unique([...granted.permissions, ...add.permissions]), origins: unique([...granted.origins, ...add.origins]) }
}

export function subtractGranted (granted: PermissionSet, remove: PermissionRequest): PermissionSet {
  return { permissions: subtract(granted.permissions, remove.permissions), origins: subtract(granted.origins, remove.origins) }
}

/** The grants that still make sense for a new `manifest`: one it now requires needs no grant, and one it no longer declares is revoked. */
export function reconcileGranted (manifest: Manifest, granted: PermissionSet): PermissionSet {
  const required = loadedRequired(manifest)
  const optional = declaredOptional(manifest)
  return {
    permissions: granted.permissions.filter((name) => optional.permissions.includes(name) && !required.permissions.includes(name)),
    origins: granted.origins.filter((origin) => covered(optional.origins, origin) && !covered(required.origins, origin))
  }
}
