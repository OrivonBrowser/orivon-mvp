// The list of files on this computer that were let use Orivon permissions, with a button to delete each one's data. One element
// kept across page redraws, so a delete waiting for its second click is not lost to a redraw made elsewhere.
import { h, replaceChildren } from '../../shared/dom.js'
import { trashIcon } from '../../shared/icons.js'
import type { SettingsState } from '../state.js'
import { isRows, localFileLine } from './local-files-model.js'
import type { LocalFileRow } from '../../../../main/privacy/local-files-domain.js'

/** A second click after this long starts over. */
const ARM_MS = 4000

const roots = new WeakMap<SettingsState, HTMLElement>()

function build (state: SettingsState): HTMLElement {
  const list = h('ul', { className: 'lf-list' })
  list.setAttribute('role', 'list')
  const notice = h('p', { className: 'problem', role: 'alert' })
  const root = h('div', { className: 'lf', id: 'local-files' }, list, notice)
  let rows: readonly LocalFileRow[] | null = null
  let armed: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const load = async (): Promise<void> => {
    const reply = await state.request('localFileData', { type: 'list' }).catch(() => undefined)
    rows = isRows(reply) ? reply.files : []
    draw()
  }

  const remove = async (row: LocalFileRow): Promise<void> => {
    clearTimeout(timer)
    armed = null
    const reply = await state.request('localFileData', { type: 'delete', id: row.id }).catch(() => undefined)
    notice.textContent = (reply as { ok?: unknown } | undefined)?.ok === true ? '' : 'Some of that could not be deleted.'
    await load()
  }

  const press = (row: LocalFileRow): void => {
    clearTimeout(timer)
    if (armed === row.id) { void remove(row); return }
    armed = row.id
    timer = setTimeout(() => { armed = null; draw() }, ARM_MS)
    draw()
  }

  function draw (): void {
    if (rows === null) { replaceChildren(list, h('li', { className: 'skeleton lf-skeleton' })); return }
    if (rows.length === 0) { replaceChildren(list, h('li', { className: 'empty-state compact' }, h('p', { textContent: 'No file on this computer has been let use Orivon permissions.' }))); return }
    replaceChildren(list, ...rows.map((row) => {
      const line = localFileLine(row)
      const label = `Delete data for ${line.name}`
      const button = armed === row.id
        ? h('button', { className: 'btn small danger armed', type: 'button', textContent: 'Click again to delete', onclick: () => { press(row) } })
        : h('button', { className: 'btn icon', type: 'button', title: label, onclick: () => { press(row) } }, trashIcon())
      button.setAttribute('aria-label', label)
      const item = h('li', { className: 'lf-row' },
        h('span', { className: 'lf-text' },
          h('span', { className: 'lf-name', textContent: line.name }),
          h('span', { className: 'lf-where muted', textContent: line.missing ? `${line.where} (not on this computer any more)` : line.where, title: row.path })),
        button)
      item.dataset['file'] = row.id
      return item
    }))
  }

  draw()
  void load()
  root.dataset['keepFocus'] = 'true'
  return root
}

/** The "Files on this computer" control: the same element on every redraw of the page. */
export function renderLocalFiles (state: SettingsState): HTMLElement {
  let root = roots.get(state)
  if (root === undefined) {
    root = build(state)
    roots.set(state, root)
  }
  return root
}
