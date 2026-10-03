// How the task manager orders and writes its rows. Pure, so the ordering
// rules and the number formats are tested without a page.

export interface Task {
  readonly key: string
  readonly pid: number
  readonly kind: string
  readonly name: string
  readonly tabId?: string | undefined
  readonly favicon?: string | null | undefined
  readonly memoryKb: number | null
  readonly cpu: number | null
  readonly endable: boolean
  readonly children: readonly TaskChild[]
}

export interface TaskChild {
  readonly key: string
  readonly kind: string
  readonly name: string
  readonly tabId?: string | undefined
  readonly favicon?: string | null | undefined
}

/** One line of the table: a process, or a page that shares the process above it. */
export interface DisplayRow {
  readonly key: string
  readonly kind: string
  readonly name: string
  readonly tabId: string | undefined
  readonly favicon: string | null | undefined
  readonly pid: number
  readonly memoryKb: number | null
  readonly cpu: number | null
  readonly endable: boolean
  readonly depth: 0 | 1
}

export type SortKey = 'name' | 'memory' | 'cpu' | 'pid'

export interface SortState {
  readonly key: SortKey
  readonly descending: boolean
}

export const DEFAULT_SORT: SortState = { key: 'memory', descending: true }

/** A click on a header: the same column reverses, another starts where its kind of value is most useful. */
export function nextSort (current: SortState, key: SortKey): SortState {
  if (current.key === key) return { key, descending: !current.descending }
  return { key, descending: key !== 'name' }
}

function compare (a: Task, b: Task, key: SortKey): number {
  switch (key) {
    case 'name': return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
    case 'memory': return (a.memoryKb ?? -1) - (b.memoryKb ?? -1)
    case 'cpu': return (a.cpu ?? -1) - (b.cpu ?? -1)
    case 'pid': return a.pid - b.pid
  }
}

/** The processes in `sort` order; a tie falls back to the name, then the key, so the order never shuffles between updates. */
export function sortTasks (tasks: readonly Task[], sort: SortState): Task[] {
  const sign = sort.descending ? -1 : 1
  return [...tasks].sort((a, b) =>
    sign * compare(a, b, sort.key) ||
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) ||
    a.key.localeCompare(b.key))
}

/** Each process followed by the pages that share it. */
export function displayRows (tasks: readonly Task[], sort: SortState): DisplayRow[] {
  return sortTasks(tasks, sort).flatMap((task): DisplayRow[] => [
    { ...task, tabId: task.tabId, favicon: task.favicon, depth: 0 },
    ...task.children.map((child): DisplayRow => ({
      key: child.key,
      kind: child.kind,
      name: child.name,
      tabId: child.tabId,
      favicon: child.favicon,
      pid: task.pid,
      memoryKb: null,
      cpu: null,
      endable: task.endable,
      depth: 1
    }))
  ])
}

const KB_PER_MB = 1024

/** "182 MB", "1.4 GB", "640 KB"; "-" for a page with no process. */
export function formatMemory (kb: number | null): string {
  if (kb === null) return '-'
  // Each unit is judged on the figure as it will be written, so just under a unit reads "1.0 GB", not "1024 MB".
  const mb = kb / KB_PER_MB
  if (Math.round(mb) >= KB_PER_MB) return `${(mb / KB_PER_MB).toFixed(1)} GB`
  if (Math.round(kb) >= KB_PER_MB) return `${Math.round(mb)} MB`
  return `${Math.round(kb)} KB`
}

/** "3.1%"; "-" while there is no reading yet. */
export function formatCpu (cpu: number | null): string {
  return cpu === null ? '-' : `${cpu.toFixed(1)}%`
}

export function formatPid (pid: number): string {
  return pid > 0 ? String(pid) : '-'
}
