// The details page's "Extra access you allowed" section: what the person
// granted an extension beyond its install, what it may still ask for, and the
// two commands that take a grant back. Pure over the prefs store and the
// manifest facts.
import { hostWords } from '../../broker/policy/extension-permission-words.js'
import { permissionLine } from '../../broker/policy/extension-manifest.js'
import { isStrippedPermissionName } from './extension-permission-check.js'
import type { ExtensionPart } from './extensions-detail-parts.js'
import type { ExtensionPageCommand } from './extensions-page-commands.js'
import { subtractGranted } from './optional-permissions.js'

export interface GrantedItem {
  readonly kind: 'permission' | 'origin'
  readonly value: string
  readonly words: string
}

export interface OptionalDetails {
  readonly granted: readonly GrantedItem[]
  /** Plain-word lines for what it declared and does not hold yet. */
  readonly mayAsk: readonly string[]
}

const wordsOf = (name: string): string => permissionLine(name) ?? name

/** Nothing when the manifest declares nothing optional, so the page leaves the section out. */
export const optionalPart: ExtensionPart = (entry, facts, deps) => {
  const declaredPermissions = (facts.manifestFacts?.optionalApiPermissions ?? []).filter((name) => !isStrippedPermissionName(name))
  const declaredOrigins = facts.manifestFacts?.optionalHostPermissions ?? []
  if (declaredPermissions.length === 0 && declaredOrigins.length === 0) return {}
  const held = deps.prefs.get(entry.id).granted
  const granted: GrantedItem[] = [
    ...declaredPermissions.filter((name) => held.permissions.includes(name)).map((value): GrantedItem => ({ kind: 'permission', value, words: wordsOf(value) })),
    ...declaredOrigins.filter((origin) => held.origins.includes(origin)).map((value): GrantedItem => ({ kind: 'origin', value, words: hostWords(value) }))
  ]
  const mayAsk = [
    ...declaredPermissions.filter((name) => !held.permissions.includes(name)).map(wordsOf),
    ...declaredOrigins.filter((origin) => !held.origins.includes(origin)).map(hostWords)
  ]
  const details: OptionalDetails = { granted, mayAsk: [...new Set(mayAsk)] }
  return { optional: details }
}

/** Takes back one granted item and tells the extension; a value that is not currently granted does nothing. */
function revoke (field: 'permissions' | 'origins'): ExtensionPageCommand {
  const key = field === 'permissions' ? 'permission' : 'origin'
  return async (body, deps) => {
    const { id } = body
    const value = body[key]
    if (typeof id !== 'string' || typeof value !== 'string') return undefined
    if (!deps.extensions.list().some((entry) => entry.id === id)) return undefined
    const granted = deps.prefs.get(id).granted
    if (!granted[field].includes(value)) return undefined
    const removed = { permissions: field === 'permissions' ? [value] : [], origins: field === 'origins' ? [value] : [] }
    deps.prefs.update(id, { granted: subtractGranted(granted, removed) })
    deps.host()?.getRouter().sendEvent(id, 'permissions.onRemoved', removed)
    await deps.extensions.applyManifest(id, 'quiet')
    return { ok: true }
  }
}

export const revokePermission = revoke('permissions')
export const revokeOrigin = revoke('origins')
