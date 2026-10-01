// The bookmark bubble and the "Bookmark all tabs" sheet, one page keyed by the overlay's name. A bookmark's name and
// folder are saved as they change, so a bubble that closes on blur has lost nothing; the folder modes and the sheet
// save on their button. Main sends ids and titles and the page sends back only those.
import type { AllTabsPayload, EditPayload, FolderChoice } from '../../../main/shell/bookmark-bubble/edit-model.js'
import { h } from '../../pages/shared/dom.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { folderOptions, NEW_FOLDER } from './folder-options.js'
import './bookmark-edit.css'

const ALL_TABS = 'bookmark-all-tabs'

const TITLES: Readonly<Record<EditPayload['mode'], string>> = {
  added: 'Bookmark added',
  edit: 'Edit bookmark',
  'rename-folder': 'Rename folder',
  'new-folder': 'New folder'
}

const isEdit = (value: unknown): value is EditPayload =>
  typeof value === 'object' && value !== null && typeof (value as EditPayload).mode === 'string' && typeof (value as EditPayload).title === 'string'
const isAllTabs = (value: unknown): value is AllTabsPayload =>
  typeof value === 'object' && value !== null && typeof (value as AllTabsPayload).count === 'number'

export const bookmarkEditPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const allTabs = overlay.name === ALL_TABS
    const root = h('div', { className: 'bme', role: 'dialog' })
    content.append(root)
    /** What Enter does in the page now drawn, and what puts a pending change into main's hands. */
    let onEnter: (() => void) | null = null
    let flush: () => void = () => {}
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing || event.target instanceof HTMLButtonElement || onEnter === null) return
      event.preventDefault()
      onEnter()
    })
    // Before the kit's own Escape handler closes the view, so what was typed is sent first.
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') flush() }, true)
    window.addEventListener('blur', () => { flush() })
    window.addEventListener('pagehide', () => { flush() })

    const field = (label: string, control: HTMLElement, extra?: HTMLElement): HTMLLabelElement =>
      h('label', { className: 'field' }, extra === undefined ? h('span', null, label) : h('span', { className: 'field-head' }, h('span', null, label), extra), control)
    const select = (folders: readonly FolderChoice[], selected: string, withNew: boolean): HTMLSelectElement => {
      const element = h('select', { className: 'select' })
      element.append(...folderOptions(folders, withNew))
      element.value = selected
      return element
    }
    const nameBox = (value: string): HTMLInputElement => h('input', { className: 'text', type: 'text', value, spellcheck: false, autocomplete: 'off' })
    const focusName = (input: HTMLInputElement): void => { input.focus(); input.select() }

    /** Builds the page for a bookmark: name, folder, Remove and Done. */
    function drawBookmark (model: EditPayload): void {
      const name = nameBox(model.title)
      name.setAttribute('aria-label', 'Name')
      const folders = select(model.folders, model.parent, true)
      folders.setAttribute('aria-label', 'Folder')
      let chosen = model.parent
      let creating: HTMLInputElement | null = null
      let sent = { title: model.title, parent: model.parent }
      const slot = h('div', { className: 'field-slot' })
      const folderField = field('Folder', folders)
      slot.append(folderField)

      const save = async (finishing: boolean): Promise<void> => {
        const newFolder = finishing && creating !== null && creating.value.trim() !== '' ? creating.value : undefined
        if (newFolder === undefined && sent.title === name.value && sent.parent === chosen) return
        sent = { title: name.value, parent: chosen }
        await overlay.request({ type: 'save', id: model.id, title: name.value, parent: chosen, ...(newFolder === undefined ? {} : { newFolder }) })
      }
      const done = (): void => { void save(true).then(() => { overlay.close() }) }

      function showFolderName (on: boolean): void {
        if (on) {
          creating = nameBox('')
          creating.setAttribute('aria-label', 'Folder name')
          const cancel = h('button', { type: 'button', className: 'link-btn' }, 'Cancel')
          cancel.addEventListener('click', () => { showFolderName(false); folders.focus() })
          slot.replaceChildren(field('Folder name', creating, cancel))
          creating.focus()
        } else {
          creating = null
          folders.value = chosen
          slot.replaceChildren(folderField)
        }
      }

      // Every keystroke goes to main: a blur closes the view before any pause could have run out.
      name.addEventListener('input', () => { void save(false) })
      folders.addEventListener('change', () => {
        if (folders.value === NEW_FOLDER) { showFolderName(true); return }
        chosen = folders.value
        void save(false)
      })

      const remove = h('button', { type: 'button', className: 'btn remove' }, 'Remove')
      remove.addEventListener('click', () => { void overlay.request({ type: 'remove', id: model.id }) })
      const finish = h('button', { type: 'button', className: 'btn primary' }, 'Done')
      finish.addEventListener('click', done)
      const title = h('h1', { className: 'sheet-title', id: 'bme-title' }, TITLES[model.mode])
      root.setAttribute('aria-labelledby', 'bme-title')
      root.replaceChildren(title, h('div', { className: 'sheet-body' }, field('Name', name), slot), h('div', { className: 'btn-row' }, remove, finish))
      flush = () => { void save(false) }
      onEnter = done
      focusName(name)
    }

    /** A folder's name alone, for "Rename folder" and "New folder": nothing is saved until Save. */
    function drawFolder (model: EditPayload): void {
      const name = nameBox(model.mode === 'new-folder' ? 'New folder' : model.title)
      name.setAttribute('aria-label', 'Name')
      const cancel = h('button', { type: 'button', className: 'btn' }, 'Cancel')
      const save = h('button', { type: 'button', className: 'btn primary' }, 'Save')
      const submit = (): void => {
        if (name.value.trim() === '') return
        void overlay.request({ type: 'saveFolder', title: name.value, ...(model.id === undefined ? {} : { id: model.id }) })
      }
      const sync = (): void => { save.disabled = name.value.trim() === '' }
      name.addEventListener('input', sync)
      cancel.addEventListener('click', () => { overlay.close() })
      save.addEventListener('click', submit)
      flush = () => {}
      onEnter = submit
      root.setAttribute('aria-labelledby', 'bme-title')
      root.replaceChildren(h('h1', { className: 'sheet-title', id: 'bme-title' }, TITLES[model.mode]), h('div', { className: 'sheet-body' }, field('Name', name)), h('div', { className: 'btn-row' }, cancel, save))
      sync()
      focusName(name)
    }

    /** The sheet for "Bookmark all tabs". */
    function drawAllTabs (model: AllTabsPayload): void {
      const name = nameBox(model.title)
      name.setAttribute('aria-label', 'Folder name')
      const where = select(model.folders, model.parent, false)
      where.setAttribute('aria-label', 'Save in')
      const cancel = h('button', { type: 'button', className: 'btn' }, 'Cancel')
      const save = h('button', { type: 'button', className: 'btn primary' }, 'Save')
      const submit = (): void => { void overlay.request({ type: 'saveAll', title: name.value, parent: where.value }) }
      cancel.addEventListener('click', () => { overlay.close() })
      save.addEventListener('click', submit)
      flush = () => {}
      onEnter = submit
      root.setAttribute('aria-labelledby', 'bme-title')
      root.replaceChildren(
        h('h1', { className: 'sheet-title', id: 'bme-title' }, 'Bookmark all tabs'),
        h('p', { className: 'bme-count' }, `${String(model.count)} ${model.count === 1 ? 'tab' : 'tabs'} in this window`),
        h('div', { className: 'sheet-body' }, field('Folder name', name), field('Save in', where)),
        h('div', { className: 'btn-row' }, cancel, save))
      focusName(name)
    }

    return {
      shown (payload) {
        if (allTabs && isAllTabs(payload)) drawAllTabs(payload)
        else if (!allTabs && isEdit(payload)) {
          if (payload.mode === 'added' || payload.mode === 'edit') drawBookmark(payload)
          else drawFolder(payload)
        } else overlay.close()
      }
    }
  }
}
