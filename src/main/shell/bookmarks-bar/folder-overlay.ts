// The folder menu: a card under a bar folder listing what is in it, with folders that open in place. The
// listing is built in ./folder-model.ts; this is the overlay's declaration, what a request does, and the
// memory a click on another folder needs to switch menus instead of being taken for the echo of a dismissal.
import { CLOSE_LIKE_POPUP } from '../../overlays/overlay-types.js'
import type { OverlayDef } from '../../overlays/overlay-types.js'
import type { ShellWindow } from '../window-registry.js'
import { asAnchor } from '../bookmark-bubble/edit-action.js'
import type { OverlayAnchor } from '../../overlays/overlay-types.js'
import { showBarMenu } from './bar-menu-runner.js'
import { asFolderRequest, asFrom, folderModel, isMenuEntry } from './folder-model.js'
import { openAll, openBookmark } from './open-bookmark.js'

export const FOLDER_OVERLAY = 'bookmark-folder'
const MENU_WIDTH = 280
/** The window in which a blur-close and the click that caused it are the same gesture (the host's own debounce). */
const ECHO_MS = 300

interface Memory {
  /** The folder the open menu was shown for. */
  shown: string | null
  /** Where the bar's folder button is: the row menu's Edit and Rename put their bubble under it. */
  anchor: OverlayAnchor | undefined
  dismissed: { id: string, at: number } | null
}

const memories = new WeakMap<ShellWindow, Memory>()
const memoryOf = (window: ShellWindow): Memory => {
  let memory = memories.get(window)
  if (memory === undefined) { memory = { shown: null, anchor: undefined, dismissed: null }; memories.set(window, memory) }
  return memory
}

/** What a click on folder `id` should do: close its open menu, switch from another folder's menu, open, or nothing (the click that dismissed it). */
export function clickOnFolder (window: ShellWindow, id: string, now: number = Date.now()): 'close' | 'show' | 'ignore' {
  const memory = memoryOf(window)
  if (window.overlays.isOpen(FOLDER_OVERLAY)) return memory.shown === id ? 'close' : 'show'
  const { dismissed } = memory
  return dismissed !== null && dismissed.id === id && now - dismissed.at < ECHO_MS ? 'ignore' : 'show'
}

export const bookmarkFolderOverlay: OverlayDef = {
  name: FOLDER_OVERLAY,
  placement: { kind: 'anchor', width: MENU_WIDTH, align: 'left' },
  surface: 'menu',
  focus: 'take',
  layer: 'popup',
  closeOn: CLOSE_LIKE_POPUP,
  keep: 'fresh',
  height: { initial: 120, min: 44, max: 460 },
  attach: (win) => {
    const { window, services } = win
    const memory = memoryOf(window)
    return {
      show: (payload) => {
        const { id, from, anchor } = (payload ?? {}) as { id?: unknown, from?: unknown, anchor?: unknown }
        const start = asFrom(from)
        const model = typeof id === 'string' && start !== null ? folderModel(services.bookmarks, id, start) : null
        memory.shown = model === null ? null : model.id
        memory.anchor = asAnchor(anchor)
        memory.dismissed = null
        return model
      },
      request: (command) => {
        const asked = asFolderRequest(command)
        if (asked === undefined) return undefined
        if (asked.type === 'children') return folderModel(services.bookmarks, asked.id, asked.from)
        if (asked.type === 'menu') {
          if (isMenuEntry(services.bookmarks, asked.id)) showBarMenu(win, asked.id, undefined, memory.anchor)
          return undefined
        }
        if (asked.type === 'remove') {
          const parent = services.bookmarks.node(asked.id)?.parent
          if (parent === undefined || !isMenuEntry(services.bookmarks, asked.id)) return undefined
          services.bookmarks.remove([asked.id])
          return folderModel(services.bookmarks, parent, asked.from)
        }
        win.close()
        if (asked.type === 'open') openBookmark(win, asked.id, asked.disposition)
        else openAll(win, asked.id)
        return undefined
      },
      closed: (reason) => {
        if (reason === 'blur' && memory.shown !== null) memory.dismissed = { id: memory.shown, at: Date.now() }
        memory.shown = null
      }
    }
  }
}
