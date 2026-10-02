// The sheet that asks whether an extension may hold more than it was installed
// with. `askPermission` queues it in the tab's centre slot (a site's own sheet
// goes first) and settles with the person's answer; anything but a click on
// Allow, after the guard below, is a refusal.
import { createKeyQuiet } from '../overlays/key-quiet.js'
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import { requestSlot, slotClosed } from '../overlays/tab-slots.js'
import type { ShellWindow } from '../shell/window-registry.js'
import type { PromptLine } from './optional-permissions.js'

export const PERMISSION_OVERLAY = 'extension-permission'

/** Allow ignores clicks for this long after the sheet appears and after the last key pressed in it, so a click or key meant for the page cannot land on it. */
export const ALLOW_GUARD_MS = 500

/** What the sheet is about, as main knows it. */
export interface PermissionAsk {
  readonly extensionId: string
  readonly name: string
  readonly icon: string | undefined
  readonly lines: readonly PromptLine[]
}

/** What the page is told on each show. */
export interface PermissionPromptView {
  readonly name: string
  readonly id: string
  readonly icon: string | undefined
  readonly lines: readonly PromptLine[]
  readonly guardMs: number
}

interface Pending {
  readonly window: ShellWindow
  readonly ask: PermissionAsk
  readonly settle: (allow: boolean) => void
}

const pending = new Map<number, Pending>()
let nextToken = 1

/** Shows the sheet for `ask` in `tabId` of `window` and resolves with the answer. A tab that closes, a window that closes, a full queue and an Escape all answer false. */
export async function askPermission (window: ShellWindow, tabId: string, ask: PermissionAsk): Promise<boolean> {
  const token = nextToken++
  return await new Promise<boolean>((resolve) => {
    let answered = false
    const settle = (allow: boolean): void => {
      if (answered) return
      answered = true
      pending.delete(token)
      resolve(allow)
    }
    pending.set(token, { window, ask, settle })
    requestSlot({ window, tabId, slot: 'center', overlay: PERMISSION_OVERLAY, payload: { token }, closed: () => { settle(false) } })
  })
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
      return { name: ask.name, id: ask.extensionId, icon: ask.icon, lines: ask.lines, guardMs: ALLOW_GUARD_MS }
    },
    request: (command) => {
      const allow = allowOf(command)
      const entry = shownToken === null ? undefined : pending.get(shownToken)
      if (allow === undefined || entry === undefined) return undefined
      if (allow && (now() - shownAt < ALLOW_GUARD_MS || keys.quietFor() < ALLOW_GUARD_MS)) return undefined
      entry.settle(allow)
      close()
      return undefined
    },
    closed: (reason) => {
      shownToken = null
      slotClosed(window, PERMISSION_OVERLAY, reason)
    },
    disposed: () => {
      for (const entry of [...pending.values()]) if (entry.window === window) entry.settle(false)
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
