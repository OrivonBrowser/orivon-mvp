// Draws the task manager from its state. The table is built once and patched:
// a row keeps its element (and so its selection, focus and the scroll position)
// across every two-second update, and only a changed cell is rewritten.
import { h } from '../shared/dom.js'
import {
  appsIcon, arrowDownIcon, arrowUpIcon, developerIcon, gearIcon, infoIcon, panelRightIcon, puzzleIcon, tabsIcon
} from '../shared/icons.js'
import { formatCpu, formatMemory, formatPid } from './sort.js'
import type { DisplayRow, SortKey } from './sort.js'
import type { TasksState } from './state.js'

const COLUMNS: ReadonlyArray<{ key: SortKey, label: string, num: boolean }> = [
  { key: 'name', label: 'Task', num: false },
  { key: 'memory', label: 'Memory', num: true },
  { key: 'cpu', label: 'CPU', num: true },
  { key: 'pid', label: 'Process ID', num: true }
]

const SKELETON_ROWS = 6

/** Processes that cannot be ended because doing so would take Orivon's own window with it. */
const OWN_KINDS: ReadonlySet<string> = new Set(['browser', 'gpu', 'shell', 'overlay'])

export function endHint (row: DisplayRow | undefined): string {
  if (row === undefined) return 'Select a tab or process to end it.'
  if (row.endable) return 'End this process. A tab shows a crashed page that a reload brings back.'
  return OWN_KINDS.has(row.kind) ? 'Ending this process would close Orivon.' : 'This process cannot be ended from here.'
}

function iconFor (row: DisplayRow): Node {
  if (typeof row.favicon === 'string' && row.favicon !== '') return h('img', { className: 'favicon', src: row.favicon, alt: '' })
  switch (row.kind) {
    case 'browser': return h('span', { className: 'logo' })
    case 'app': return appsIcon()
    case 'extension': return puzzleIcon()
    case 'internal': return gearIcon()
    case 'overlay': case 'shell': return panelRightIcon()
    case 'utility': case 'gpu': return developerIcon()
    case 'tab': return tabsIcon()
    default: return infoIcon()
  }
}

function setText (element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text
}

export interface TasksView {
  readonly element: HTMLElement
  render: (state: TasksState) => void
}

export function createTasksView (state: TasksState): TasksView {
  const endButton = h('button', { className: 'btn danger', type: 'button', textContent: 'End process', disabled: true, onclick: () => { void state.endSelected() } })
  const notice = h('div', { className: 'banner error', role: 'alert', hidden: true })
  const unavailable = h('div', { className: 'banner error', role: 'alert', hidden: true },
    'Process information is not available. ',
    h('button', { className: 'link-btn', type: 'button', textContent: 'Try again', onclick: () => { void state.refresh() } }))

  const headers = COLUMNS.map((column) => {
    const arrow = h('span', { className: 'sort-arrow' })
    const button = h('button', { className: 'sort', type: 'button', onclick: () => { state.sortBy(column.key) } },
      h('span', { textContent: column.label }), arrow)
    const cell = h('th', { className: column.num ? 'num' : 'task' }, button)
    cell.scope = 'col'
    return { column, arrow, cell }
  })

  const body = h('tbody', { className: 'rows' })
  const totalMemory = h('td', { className: 'num' })
  const totalCpu = h('td', { className: 'num' })
  const table = h('table', { className: 'grid', role: 'grid', ariaLabel: 'Processes' },
    h('colgroup', null, h('col'), h('col', { className: 'col-memory' }), h('col', { className: 'col-cpu' }), h('col', { className: 'col-pid' })),
    h('thead', null, h('tr', null, ...headers.map((header) => header.cell))),
    body,
    h('tfoot', null, h('tr', null, h('td', { className: 'task', textContent: 'Total' }), totalMemory, totalCpu, h('td', { className: 'num' }))))

  const elements = new Map<string, HTMLTableRowElement>()
  let skeletonShown = false

  function skeletonRows (): HTMLTableRowElement[] {
    return Array.from({ length: SKELETON_ROWS }, (_, index) => {
      const cell = (className: string, width: string): HTMLTableCellElement => {
        const bar = h('span', { className: 'skeleton' })
        bar.style.width = width
        return h('td', { className: className }, bar)
      }
      return h('tr', { className: 'loading', role: 'row' }, cell('task', index % 2 === 0 ? '60%' : '40%'), cell('num', '70%'), cell('num', '50%'), cell('num', '60%'))
    })
  }

  function createRow (): HTMLTableRowElement {
    const row = h('tr', { role: 'row', tabIndex: -1 },
      h('td', { className: 'task' }, h('span', { className: 'task-icon' }), h('span', { className: 'task-name' })),
      h('td', { className: 'num' }), h('td', { className: 'num' }), h('td', { className: 'num' }))
    row.addEventListener('click', () => { state.select(row.dataset['key'] ?? null); row.focus() })
    row.addEventListener('dblclick', () => {
      const data = state.rows().find((candidate) => candidate.key === row.dataset['key'])
      if (data !== undefined) void state.goTo(data)
    })
    return row
  }

  function patch (row: HTMLTableRowElement, data: DisplayRow, selected: boolean, tabbable: boolean): void {
    row.dataset['key'] = data.key
    row.className = `${data.depth === 1 ? 'child' : ''}${selected ? ' selected' : ''}`.trim()
    row.setAttribute('aria-selected', String(selected))
    row.setAttribute('aria-level', String(data.depth + 1))
    row.tabIndex = tabbable ? 0 : -1
    const cells = row.cells
    const nameCell = cells[0]
    const name = nameCell?.querySelector<HTMLElement>('.task-name')
    if (nameCell === undefined || name === undefined || name === null) return
    setText(name, data.name)
    name.title = data.name
    const signature = `${data.kind}|${data.favicon ?? ''}`
    const slot = nameCell.querySelector<HTMLElement>('.task-icon')
    if (slot !== null && slot.dataset['sig'] !== signature) {
      slot.dataset['sig'] = signature
      slot.replaceChildren(iconFor(data))
    }
    if (cells[1] !== undefined) setText(cells[1], formatMemory(data.memoryKb))
    if (cells[2] !== undefined) setText(cells[2], formatCpu(data.cpu))
    if (cells[3] !== undefined) setText(cells[3], data.depth === 1 ? '' : formatPid(data.pid))
  }

  function render (): void {
    for (const header of headers) {
      const sorted = state.sort.key === header.column.key
      header.cell.setAttribute('aria-sort', sorted ? (state.sort.descending ? 'descending' : 'ascending') : 'none')
      header.arrow.replaceChildren(...(sorted ? [state.sort.descending ? arrowDownIcon() : arrowUpIcon()] : []))
    }
    const selectedRow = state.selected()
    endButton.disabled = selectedRow === undefined || !selectedRow.endable
    endButton.title = endHint(selectedRow)
    notice.hidden = state.notice === null
    setText(notice, state.notice ?? '')
    unavailable.hidden = !(state.failed && state.tasks.length === 0)

    if (!state.loaded) {
      if (!skeletonShown) {
        body.replaceChildren(...skeletonRows())
        skeletonShown = true
      }
      return
    }
    if (skeletonShown) {
      body.replaceChildren()
      skeletonShown = false
    }

    const rows = state.rows()
    const keys = new Set(rows.map((row) => row.key))
    const active = document.activeElement
    const focusedKey = active instanceof HTMLTableRowElement && body.contains(active) ? active.dataset['key'] : undefined
    const focusedIndex = focusedKey === undefined ? -1 : [...body.rows].findIndex((row) => row.dataset['key'] === focusedKey)
    const tabbableKey = state.selectedKey !== null && keys.has(state.selectedKey) ? state.selectedKey : rows[0]?.key

    rows.forEach((data, index) => {
      let row = elements.get(data.key)
      if (row === undefined) {
        row = createRow()
        elements.set(data.key, row)
      }
      patch(row, data, data.key === state.selectedKey, data.key === tabbableKey)
      const expected = body.rows[index]
      if (expected !== row) body.insertBefore(row, expected ?? null)
    })
    for (const [key, row] of elements) {
      if (keys.has(key)) continue
      row.remove()
      elements.delete(key)
    }
    // A focused row that was moved or removed hands focus to the row now at its place, so the keyboard keeps its spot.
    if (focusedKey !== undefined && document.activeElement !== elements.get(focusedKey)) {
      const target = elements.get(focusedKey) ?? body.rows[Math.min(focusedIndex, body.rows.length - 1)]
      target?.focus({ preventScroll: true })
    }
    setText(totalMemory, formatMemory(state.totals.memoryKb))
    setText(totalCpu, formatCpu(state.totals.cpu))
  }

  body.addEventListener('keydown', (event) => {
    const rows = state.rows()
    const index = rows.findIndex((row) => row.key === state.selectedKey)
    const at = (next: number): void => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, next))]
      if (row === undefined) return
      state.select(row.key)
      elements.get(row.key)?.focus()
    }
    switch (event.key) {
      case 'ArrowDown': at(index + 1); break
      case 'ArrowUp': at(index === -1 ? 0 : index - 1); break
      case 'Home': at(0); break
      case 'End': at(rows.length - 1); break
      case 'Enter': { const row = rows[index]; if (row !== undefined) void state.goTo(row); break }
      case 'Delete': void state.endSelected(); break
      default: return
    }
    event.preventDefault()
  })

  const element = h('main', { className: 'page' },
    h('header', { className: 'head' },
      h('div', { className: 'head-text' },
        h('h1', null, developerIcon(), 'Task manager'),
        h('p', { className: 'intro', textContent: 'Memory and processor use of Orivon\'s processes. Updates every 2 seconds.' })),
      endButton),
    notice,
    unavailable,
    h('div', { className: 'table-wrap card' }, table))

  return { element, render: () => { render() } }
}
