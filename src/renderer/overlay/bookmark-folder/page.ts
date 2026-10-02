// The bookmark folder menu: the rows of one folder of the bookmarks bar, folders that open in place under a row
// that goes back, and "Open all" at the foot. A click opens in the tab; a middle or Mod click opens behind it and
// Shift opens a window. Only ids go to main, which reads the addresses from the store.
import type { FolderModel, FolderRow } from '../../../main/shell/bookmarks-bar/folder-model.js'
import { faviconElement } from '../../icons.js'
import { h } from '../../pages/shared/dom.js'
import { chevronRightIcon, folderIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { nextRow } from '../menu/keys.js'
import type { NavKey } from '../menu/keys.js'
import './bookmark-folder.css'

const NAV_KEYS: readonly string[] = ['ArrowDown', 'ArrowUp', 'Home', 'End']

type Disposition = 'current' | 'background' | 'window'
interface Level { id: string, from?: number }

const isModel = (value: unknown): value is FolderModel =>
  typeof value === 'object' && value !== null && Array.isArray((value as FolderModel).rows) && typeof (value as FolderModel).id === 'string'

export function openAllLabel (pages: number, limit: number): string {
  return pages > limit ? `Open all (${String(limit)} of ${String(pages)})` : `Open all (${String(pages)})`
}

export const bookmarkFolderPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    /** Where the person is: the folder shown first, then each folder opened from it. */
    let levels: Level[] = []
    let model: FolderModel | null = null
    let rows: HTMLElement[] = []
    const list = h('div', { className: 'bmf', role: 'menu', ariaLabel: 'Bookmarks' })
    content.append(list)

    const dispositionOf = (event: MouseEvent): Disposition =>
      event.shiftKey ? 'window' : event.ctrlKey || event.metaKey || event.button === 1 ? 'background' : 'current'

    function rowFor (row: FolderRow): HTMLElement {
      const folder = row.kind === 'folder'
      const label = row.title.length > 0 ? row.title : (row.url ?? '')
      const button = h('button', { type: 'button', className: 'bmf-row', role: 'menuitem', title: folder ? label : (row.url ?? label) },
        h('span', { className: 'bmf-icon' }, folder ? folderIcon() : faviconElement(row.favicon ?? null)),
        h('span', { className: 'bmf-label' }, label),
        folder && h('span', { className: 'bmf-chevron' }, chevronRightIcon()))
      button.dataset['key'] = row.id
      if (folder) button.setAttribute('aria-haspopup', 'menu')
      button.addEventListener('click', (event) => {
        if (folder) drill(row.id)
        else void overlay.request({ type: 'open', id: row.id, disposition: dispositionOf(event) })
      })
      // The bar's own right-click menu, popped up by main at the pointer.
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        void overlay.request({ type: 'menu', id: row.id })
      })
      // A middle press would start Chromium's autoscroll before the release that opens the page.
      button.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault() })
      button.addEventListener('auxclick', (event) => {
        if (event.button === 1 && !folder) void overlay.request({ type: 'open', id: row.id, disposition: 'background' })
      })
      return button
    }

    function render (focusKey?: string): void {
      rows = []
      const children: Node[] = []
      if (model === null) { list.replaceChildren(); return }
      if (levels.length > 1) {
        const back = h('button', { type: 'button', className: 'bmf-row bmf-back', role: 'menuitem', onclick: goBack },
          h('span', { className: 'bmf-icon bmf-arrow' }, chevronRightIcon()), h('span', { className: 'bmf-label' }, model.title))
        back.dataset['key'] = 'back'
        back.setAttribute('aria-label', `Back from ${model.title}`)
        rows.push(back)
        children.push(back, h('div', { className: 'bmf-separator', role: 'separator' }))
      }
      if (model.rows.length === 0) children.push(h('div', { className: 'bmf-empty', role: 'presentation' }, '(empty)'))
      for (const row of model.rows) {
        const el = rowFor(row)
        rows.push(el)
        children.push(el)
      }
      if (model.more > 0) children.push(h('div', { className: 'bmf-empty', role: 'presentation' }, `${String(model.more)} more not shown`))
      if (model.from === undefined && model.pages > 0) {
        const all = h('button', { type: 'button', className: 'bmf-row bmf-all', role: 'menuitem',
          onclick: () => { void overlay.request({ type: 'openAll', id: model?.id ?? '' }) } },
        h('span', { className: 'bmf-label' }, openAllLabel(model.pages, model.openAllLimit)))
        all.dataset['key'] = 'all'
        rows.push(all)
        children.push(h('div', { className: 'bmf-separator', role: 'separator' }), all)
      }
      list.replaceChildren(...children)
      if (focusKey !== undefined) list.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus()
    }

    async function load (level: Level, focusKey?: string): Promise<void> {
      const next = await overlay.request<unknown>({ type: 'children', id: level.id, ...(level.from === undefined ? {} : { from: level.from }) })
      if (!isModel(next)) { overlay.close(); return }
      model = next
      render(focusKey)
    }

    function drill (id: string): void {
      levels = [...levels, { id }]
      void load({ id }).then(() => { rows[levels.length > 1 ? 1 : 0]?.focus() })
    }

    function goBack (): void {
      const from = levels.at(-1)?.id
      levels = levels.slice(0, -1)
      const level = levels.at(-1)
      if (level !== undefined) void load(level, from)
    }

    /** Deletes the focused bookmark or folder and lists the folder again, the focus on the row that took its place. */
    async function removeAt (at: number, key: string): Promise<void> {
      const level = levels.at(-1)
      if (level === undefined) return
      const next = await overlay.request<unknown>({ type: 'remove', id: key, ...(level.from === undefined ? {} : { from: level.from }) })
      if (!isModel(next)) return
      model = next
      render()
      rows[Math.min(at, rows.length - 1)]?.focus()
    }

    document.addEventListener('keydown', (event) => {
      const at = rows.findIndex((row) => row === document.activeElement)
      const key = (document.activeElement as HTMLElement | null)?.dataset['key']
      const deleting = event.key === 'Delete' || (event.key === 'Backspace' && (event.ctrlKey || event.metaKey))
      if (deleting && key !== undefined && key !== 'back' && key !== 'all') {
        event.preventDefault()
        void removeAt(at, key)
      } else if (NAV_KEYS.includes(event.key)) {
        event.preventDefault()
        rows[nextRow(rows.length, at, event.key as NavKey)]?.focus()
      } else if (event.key === 'ArrowRight' && document.activeElement?.getAttribute('aria-haspopup') === 'menu') {
        event.preventDefault();
        (document.activeElement as HTMLElement).click()
      } else if ((event.key === 'ArrowLeft' || event.key === 'Backspace') && levels.length > 1) {
        event.preventDefault()
        goBack()
      }
    })

    return {
      shown (payload) {
        model = isModel(payload) ? payload : null
        if (model === null) { overlay.close(); return }
        levels = [{ id: model.id, ...(model.from === undefined ? {} : { from: model.from }) }]
        render()
        // Opened by a click a highlighted first row would read as chosen; the arrow keys reach a row from nothing.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        content.parentElement?.scrollTo({ top: 0 })
      }
    }
  }
}
