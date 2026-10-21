// The sheet that asks whether an extension may hold more than it was installed
// with, or may use a device. `askPermission` queues it in the tab's centre slot
// (a site's own sheet goes first) and settles with the person's answer;
// anything but a click on Allow, after the guard below, is a refusal.
// `askPermissionChoice` also tells a click on the refusing button from closing
// the sheet, which a device question stores differently.
import { createKeyQuiet } from '../overlays/key-quiet.js'
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import { requestSlot, slotClosed } from '../overlays/tab-slots.js'
import type { ShellWindow } from '../shell/window-registry.js'
import type { PromptLine } from './optional-permissions.js'

export const PERMISSION_OVERLAY = 'extension-permission'

/** Allow ignores clicks for this long after the sheet appears and after the last key pressed in it, so a click or key meant for the page cannot land on it. */
export const ALLOW_GUARD_MS = 500

const MAX_NAME_LENGTH = 120

/** Control and format characters (bidi overrides, zero-width marks) could reorder or hide words of the question, so they never reach the sheet. */
export function clipName (raw: string): string {
  const name = raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()
  return name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…` : name
}

/** What the sheet is about, as main knows it. */
export interface PermissionAsk {
  readonly extensionId: string
  readonly name: string
  readonly icon: string | undefined
  readonly lines: readonly PromptLine[]
  /** What the extension wants to do with a device, in words ("wants to use your camera"): the sheet then asks that question and lists nothing. */
  readonly wants?: string | undefined
}

/** What the page is told on each show. */
export interface PermissionPromptView {
  readonly name: string
  readonly id: string
  readonly icon: string | undefined
  readonly lines: readonly PromptLine[]
  readonly wants: string | undefined
  readonly guardMs: number
}

/** `block` is a click on the refusing button; `dismiss` is every other way out (Escape, a click elsewhere, a closed tab or window, a full queue). */
export type PermissionChoice = 'allow' | 'block' | 'dismiss'

interface Pending {
  readonly window: ShellWindow
  readonly ask: PermissionAsk
  readonly settle: (choice: PermissionChoice) => void
}

const pending = new Map<number, Pending>()
let nextToken = 1

/** Shows the sheet for `ask` in `tabId` of `window` and resolves with what the person did. */
export async function askPermissionChoice (window: ShellWindow, tabId: string, ask: PermissionAsk): Promise<PermissionChoice> {
  const token = nextToken++
  return await new Promise<PermissionChoice>((resolve) => {
    let answered = false
    const settle = (choice: PermissionChoice): void => {
      if (answered) return
      answered = true
      pending.delete(token)
      resolve(choice)
    }
    pending.set(token, { window, ask, settle })
    requestSlot({ window, tabId, slot: 'center', overlay: PERMISSION_OVERLAY, payload: { token }, closed: () => { settle('dismiss') } })
  })
}

/** True only for a click on Allow. A tab that closes, a window that closes, a full queue and an Escape all answer false. */
export async function askPermission (window: ShellWindow, tabId: string, ask: PermissionAsk): Promise<boolean> {
  return await askPermissionChoice(window, tabId, ask) === 'allow'
}

function tokenOf (payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { token } = payload as { token?: unknown }
  return typeof token === 'number' ? token : undefined
}

function allowOf (command: unknown): boolean | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const { allow, ...rest } = command as Record<string, unknown>
  return typeof allow === 'boolean' && Object.keys(rest).length === 0 ? allow : undefined
}

export function createPermissionPrompt ({ window, close }: OverlayWindow, now: () => number = Date.now): OverlayHandler {
  let shownToken: number | null = null
  let shownAt = 0
  // Tab, Tab, Enter typed at a page that raises the sheet as the person types must not reach Allow: the keyboard has to be quiet for the guard's length too.
  const keys = createKeyQuiet(now)
  return {
    key: keys.onKey,
    show: (payload): PermissionPromptView | undefined => {
      const token = tokenOf(payload)
      const entry = token === undefined ? undefined : pending.get(token)
      if (token === undefined || entry === undefined) { shownToken = null; return undefined }
      shownToken = token
      shownAt = now()
      keys.reset()
      const { ask } = entry
      return { name: ask.name, id: ask.extensionId, icon: ask.icon, lines: ask.lines, wants: ask.wants, guardMs: ALLOW_GUARD_MS }
    },
    request: (command) => {
      const allow = allowOf(command)
      const entry = shownToken === null ? undefined : pending.get(shownToken)
      if (allow === undefined || entry === undefined) return undefined
      if (allow && (now() - shownAt < ALLOW_GUARD_MS || keys.quietFor() < ALLOW_GUARD_MS)) return undefined
      entry.settle(allow ? 'allow' : 'block')
      close()
      return undefined
    },
    closed: (reason) => {
      shownToken = null
      slotClosed(window, PERMISSION_OVERLAY, reason)
    },
    disposed: () => {
      for (const entry of [...pending.values()]) if (entry.window === window) entry.settle('dismiss')
    }
  }
}

export const permissionOverlay: OverlayDef = {
  name: PERMISSION_OVERLAY,
  placement: { kind: 'area', at: 'center', width: 420 },
  surface: 'panel',
  focus: 'take',
  layer: 'popup',
  closeOn: { blur: true, tabSwitch: true, navigation: false, layout: false },
  keep: 'fresh',
  height: { min: 200, max: 460 },
  attach: (win) => createPermissionPrompt(win)
}
