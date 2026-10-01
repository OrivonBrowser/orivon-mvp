// chrome.permissions: what an extension holds, and a request for more that a
// person answers in Orivon's own sheet. Replaces the library's handlers (a
// later `handle` on the same name wins). Nothing is granted without a click on
// Allow, and only what the manifest declared can be asked for.
import type { WebContents } from 'electron'
import type { ApiEvent, ExtensionApiContext, ExtensionApiModule } from './api/api-types.js'
import { parentOf } from './extension-popup-policy.js'
import { readExtensionFacts } from './extensions-view-runner.js'
import { setGrantedHostSource } from './granted-host-rule.js'
import {
  classifyRequest, heldSet, mergeGranted, patternCovers, promptLines, requiredOf, subtractGranted,
  type PermissionRequest, type PermissionSet
} from './optional-permissions.js'
import { createNagLimit, type NagLimit } from './permission-nag-limit.js'
import { askPermission, type PermissionAsk } from './permission-prompt-overlay.js'
import type { ShellWindow } from '../shell/window-registry.js'

export const GESTURE_ERROR = 'This function must be called during a user gesture'
export const UNDECLARED_ERROR = 'Only permissions specified in the manifest may be requested.'
export const NEVER_ERROR = 'Orivon does not provide this permission.'
export const BUSY_ERROR = 'Another permission request from this extension is already open.'
export const NAGGING_ERROR = 'This extension asked too often. Try again later.'
const INVALID_ERROR = 'The permissions request is not valid.'
const NO_WINDOW_ERROR = 'There is no window to ask in.'

const MAX_ITEMS = 50
const MAX_ITEM_LENGTH = 300
const MAX_NAME_LENGTH = 40

function listOf (value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error(INVALID_ERROR)
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || item.length > MAX_ITEM_LENGTH) throw new Error(INVALID_ERROR)
  }
  return value as string[]
}

/** A request is `{ permissions?, origins? }` and nothing else. */
export function parseRequest (raw: unknown): PermissionRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(INVALID_ERROR)
  const { permissions, origins, ...rest } = raw as Record<string, unknown>
  if (Object.keys(rest).length > 0) throw new Error(INVALID_ERROR)
  return { permissions: listOf(permissions), origins: listOf(origins) }
}

export interface PermissionsApiDeps {
  /** The window and tab the person is looking at for a call; undefined when there is none. */
  readonly target: (event: ApiEvent) => { window: ShellWindow, tabId: string } | undefined
  readonly ask: (window: ShellWindow, tabId: string, ask: PermissionAsk) => Promise<boolean>
  /** The extension's name and icon as a person reads them. */
  readonly identity: (extensionId: string, fallbackName: string) => Promise<{ name: string, icon: string | undefined }>
  readonly nag: NagLimit
}

function clip (name: string): string {
  return name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…` : name
}

function windowTarget (ctx: ExtensionApiContext, event: ApiEvent): { window: ShellWindow, tabId: string } | undefined {
  const windows = ctx.shell()?.windows
  if (windows === undefined || event.type !== 'frame' || event.sender === undefined) return undefined
  const contents = event.sender as WebContents
  const inTab = windows.findTab(contents)
  const parent = inTab === null ? parentOf(contents) : undefined
  const window = inTab?.window ?? (parent === undefined ? windows.focused() : windows.all().find((entry) => entry.window === parent))
  const tabId = window?.tabs.getState().activeTabId
  return window === undefined || tabId === null || tabId === undefined ? undefined : { window, tabId: inTab?.tabId ?? tabId }
}

async function identityOf (ctx: ExtensionApiContext, extensionId: string, fallbackName: string): Promise<{ name: string, icon: string | undefined }> {
  const entry = ctx.extensions()?.list().find((candidate) => candidate.id === extensionId)
  if (entry === undefined) return { name: fallbackName, icon: undefined }
  const facts = await readExtensionFacts(entry)
  return { name: facts.resolvedName, icon: facts.iconDataUrl }
}

export function installPermissions (ctx: ExtensionApiContext, deps: PermissionsApiDeps): void {
  setGrantedHostSource(ctx.prefs)
  const asking = new Set<string>()

  const grantedOf = (id: string): PermissionSet => ctx.prefs.get(id).granted
  const heldOf = (event: ApiEvent): PermissionSet => heldSet(event.extension.manifest, grantedOf(event.extension.id))

  function persist (id: string, granted: PermissionSet, event: 'permissions.onAdded' | 'permissions.onRemoved', changed: PermissionRequest): void {
    ctx.prefs.update(id, { granted })
    ctx.sendEvent(id, event, { permissions: [...changed.permissions], origins: [...changed.origins] })
    void ctx.extensions()?.applyManifest(id, 'quiet').catch((error: unknown) => {
      console.error(`[extensions] applying the permissions of ${id} failed:`, error)
    })
  }

  ctx.handle('permissions.contains', (event, raw) => {
    const request = parseRequest(raw)
    const id = event.extension.id
    const held = heldOf(event)
    return request.permissions.every((name) => held.permissions.includes(name) || ctx.held(id, name)) &&
      request.origins.every((origin) => held.origins.some((pattern) => patternCovers(pattern, origin)))
  })

  ctx.handle('permissions.getAll', (event) => {
    const held = heldOf(event)
    return { permissions: [...held.permissions], origins: [...held.origins] }
  })

  ctx.handle('permissions.request', async (event, raw, gesture) => {
    const id = event.extension.id
    const request = parseRequest(raw)
    const outcome = classifyRequest(event.extension.manifest, grantedOf(id), request)
    if (outcome.kind === 'held') return true
    if (outcome.kind === 'never') throw new Error(NEVER_ERROR)
    if (outcome.kind === 'undeclared') throw new Error(UNDECLARED_ERROR)
    if (event.type !== 'frame' || gesture !== true) throw new Error(GESTURE_ERROR)
    if (deps.nag.suspended(id)) throw new Error(NAGGING_ERROR)
    if (asking.has(id)) throw new Error(BUSY_ERROR)
    const target = deps.target(event)
    if (target === undefined) throw new Error(NO_WINDOW_ERROR)

    asking.add(id)
    let allowed: boolean
    try {
      const who = await deps.identity(id, String(event.extension.manifest['name'] ?? id))
      allowed = await deps.ask(target.window, target.tabId, {
        extensionId: id,
        name: clip(who.name),
        icon: who.icon,
        lines: promptLines(outcome)
      })
    } finally {
      asking.delete(id)
    }
    if (!allowed) {
      deps.nag.denied(id)
      return false
    }
    deps.nag.allowed(id)
    if (ctx.session.extensions.getExtension(id) == null) return false
    persist(id, mergeGranted(grantedOf(id), outcome), 'permissions.onAdded', outcome)
    return true
  })

  ctx.handle('permissions.remove', (event, raw) => {
    const id = event.extension.id
    const request = parseRequest(raw)
    const granted = grantedOf(id)
    const required = requiredOf(event.extension.manifest, granted)
    const requiredAsked = request.permissions.some((name) => required.permissions.includes(name) && !granted.permissions.includes(name)) ||
      request.origins.some((origin) => required.origins.some((pattern) => patternCovers(pattern, origin)) && !granted.origins.includes(origin))
    if (requiredAsked) return false
    const removed: PermissionRequest = {
      permissions: request.permissions.filter((name) => granted.permissions.includes(name)),
      origins: request.origins.filter((origin) => granted.origins.includes(origin))
    }
    if (removed.permissions.length === 0 && removed.origins.length === 0) return true
    persist(id, subtractGranted(granted, removed), 'permissions.onRemoved', removed)
    return true
  })

  ctx.handle('permissions.addHostAccessRequest', () => undefined)
  ctx.handle('permissions.removeHostAccessRequest', () => undefined)
}

export const permissionsApi: ExtensionApiModule = {
  name: 'permissions',
  install: (ctx) => {
    installPermissions(ctx, {
      target: (event) => windowTarget(ctx, event),
      ask: askPermission,
      identity: async (id, fallback) => await identityOf(ctx, id, fallback),
      nag: createNagLimit()
    })
  }
}
