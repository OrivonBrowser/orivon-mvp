// The two overlays of this directory: the bubble under the star (one bookmark, or a folder's name) and the sheet
// for "Bookmark all tabs". Both hand the page a model on show and accept a short list of commands, each checked
// against what was shown: a page can change the bookmark it was opened for, and nothing else.
import { CLOSE_LIKE_POPUP } from '../../overlays/overlay-types.js'
import type { OverlayDef, OverlayWindow } from '../../overlays/overlay-types.js'
import { ALL_TABS_OVERLAY, EDIT_OVERLAY, rememberFolder } from './bubble-state.js'
import { applyEdit, applyFolderEdit, applySaveAll, asEditCommand, editPayload, folderChoices, folderNameForToday, tabsToBookmark } from './edit-model.js'
import type { AllTabsPayload, EditMode } from './edit-model.js'

const BUBBLE_WIDTH = 320
const SHEET_WIDTH = 360
const MODES: readonly string[] = ['added', 'edit', 'rename-folder', 'new-folder']

/** What the bubble was opened for; a command must name the same bookmark or folder. */
type Shown = { mode: 'added', id: string } | { mode: 'edit', id: string } | { mode: 'rename-folder', id: string } | { mode: 'new-folder', parent: string }

function asShow (payload: unknown): { mode: EditMode, id: string } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { mode, id } = payload as Record<string, unknown>
  return typeof mode === 'string' && MODES.includes(mode) && typeof id === 'string' ? { mode: mode as EditMode, id } : undefined
}

function attachEdit (win: OverlayWindow): ReturnType<OverlayDef['attach']> {
  const { services } = win
  let shown: Shown | null = null
  return {
    show: (payload) => {
      shown = null
      const asked = asShow(payload)
      const model = asked === undefined ? undefined : editPayload(services.bookmarks, asked.mode, asked.id)
      if (asked === undefined || model === undefined) return undefined
      shown = asked.mode === 'new-folder' ? { mode: 'new-folder', parent: asked.id } : { mode: asked.mode, id: asked.id }
      return model
    },
    request: (command) => {
      const asked = asEditCommand(command)
      const open = shown
      if (asked === undefined || open === null) return undefined
      if (asked.type === 'save' || asked.type === 'remove') {
        if ((open.mode !== 'added' && open.mode !== 'edit') || asked.id !== open.id) return undefined
        const outcome = applyEdit(services.bookmarks, asked)
        if (asked.type === 'remove') win.close()
        else if (outcome.ok) rememberFolder(services.bookmarks, outcome.folder ?? asked.parent)
        return outcome
      }
      if (asked.type !== 'saveFolder' || open.mode === 'added' || open.mode === 'edit') return undefined
      // A rename names its folder and a new folder goes where the bubble was opened: the page has no say in either.
      let outcome: ReturnType<typeof applyFolderEdit> = { ok: false }
      if (open.mode === 'rename-folder') {
        if (asked.id === open.id) outcome = applyFolderEdit(services.bookmarks, { type: 'saveFolder', id: open.id, title: asked.title })
      } else {
        outcome = applyFolderEdit(services.bookmarks, { type: 'saveFolder', parent: open.parent, title: asked.title })
      }
      if (outcome.ok) win.close()
      return outcome
    },
    closed: () => { shown = null }
  }
}

function attachAllTabs (win: OverlayWindow): ReturnType<OverlayDef['attach']> {
  const { window, services } = win
  const tabsNow = (): ReturnType<typeof tabsToBookmark> => tabsToBookmark(window.tabs.getState().tabs, (id) => window.tabs.faviconFor(id))
  return {
    show: (): AllTabsPayload | undefined => {
      const count = tabsNow().length
      return count === 0 ? undefined : { count, title: folderNameForToday(new Date()), parent: 'bar', folders: folderChoices(services.bookmarks) }
    },
    request: (command) => {
      const asked = asEditCommand(command)
      if (asked?.type !== 'saveAll') return undefined
      // The tabs are read again here: the page's count is only what it displayed.
      const saved = applySaveAll(services.bookmarks, asked, tabsNow(), folderNameForToday(new Date()))
      if (saved > 0) win.close()
      return { ok: saved > 0, saved }
    }
  }
}

const POPUP = { ...CLOSE_LIKE_POPUP, navigation: true }

export const bookmarkEditOverlay: OverlayDef = {
  name: EDIT_OVERLAY,
  placement: { kind: 'anchor', width: BUBBLE_WIDTH, align: 'left' },
  surface: 'panel',
  focus: 'take',
  layer: 'popup',
  closeOn: POPUP,
  keep: 'fresh',
  height: { initial: 210, min: 120, max: 320 },
  attach: attachEdit
}

export const bookmarkAllTabsOverlay: OverlayDef = {
  name: ALL_TABS_OVERLAY,
  placement: { kind: 'area', at: 'top-center', width: SHEET_WIDTH },
  surface: 'panel',
  focus: 'take',
  layer: 'popup',
  closeOn: POPUP,
  keep: 'fresh',
  height: { initial: 300, min: 200, max: 400 },
  attach: attachAllTabs
}
