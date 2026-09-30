// The task manager's rows: the process metrics Electron reports, joined with
// what main knows each process is showing. Pure, so the naming, the choice of
// what may be ended and the totals are tested without a running browser.

/** One process from `app.getAppMetrics()`, reduced to what the page shows. */
export interface MetricInput {
  readonly pid: number
  readonly type: string
  /** Percent of one core, or null for the first reading, which Electron reports as 0. */
  readonly cpu: number | null
  readonly memoryKb: number
  readonly name?: string | undefined
  readonly serviceName?: string | undefined
}

export type ContentsKind = 'tab' | 'app' | 'extension' | 'internal' | 'overlay' | 'shell'

/** A page main can name: a tab, an extension's page, one of Orivon's own views. */
export interface ContentsInput {
  /** The renderer process it runs in; 0 when it has none (a crashed or parked tab). */
  readonly pid: number
  readonly kind: ContentsKind
  readonly name: string
  readonly tabId?: string | undefined
  readonly favicon?: string | null | undefined
}

export type TaskKind = 'browser' | 'gpu' | 'tab' | 'app' | 'extension' | 'utility' | 'internal' | 'overlay' | 'shell' | 'other'

export interface TaskChild {
  readonly key: string
  readonly kind: TaskKind
  readonly name: string
  readonly tabId?: string
  readonly favicon?: string | null
}

export interface TaskRow extends TaskChild {
  readonly pid: number
  /** Null for a tab with no process to measure. */
  readonly memoryKb: number | null
  readonly cpu: number | null
  readonly endable: boolean
  /** Pages sharing this row's process, listed beneath it. */
  readonly children: readonly TaskChild[]
}

export interface TaskTotals {
  readonly memoryKb: number
  readonly cpu: number | null
}

/** Which page names a shared process: a person's own page before Orivon's. */
const PRECEDENCE: readonly ContentsKind[] = ['tab', 'app', 'extension', 'internal', 'overlay', 'shell']

const ENDABLE_KINDS: ReadonlySet<ContentsKind> = new Set(['tab', 'app', 'extension'])

export const NEW_TAB_NAME = 'New tab'

export function labelFor (kind: TaskKind, name: string): string {
  switch (kind) {
    case 'tab': return `Tab: ${name === '' ? NEW_TAB_NAME : name}`
    case 'app': return `App: ${name}`
    case 'extension': return `Extension: ${name}`
    case 'internal': return `Internal page: ${name}`
    case 'utility': return `Utility: ${name}`
    case 'overlay': return 'Overlay'
    case 'shell': return 'Orivon window'
    case 'browser': return 'Browser'
    case 'gpu': return 'GPU process'
    case 'other': return name === '' ? 'Other' : name
  }
}

function child (entry: ContentsInput, index: number): TaskChild {
  return {
    key: entry.tabId !== undefined ? `tab:${entry.tabId}` : `c:${entry.pid}:${index}`,
    kind: entry.kind,
    name: labelFor(entry.kind, entry.name),
    ...(entry.tabId === undefined ? {} : { tabId: entry.tabId }),
    ...(entry.favicon === undefined ? {} : { favicon: entry.favicon })
  }
}

function byPrecedence (a: ContentsInput, b: ContentsInput): number {
  return PRECEDENCE.indexOf(a.kind) - PRECEDENCE.indexOf(b.kind)
}

function row (pid: number, metric: MetricInput | undefined, entries: readonly ContentsInput[]): TaskRow {
  const sorted = [...entries].sort(byPrecedence)
  const [first, ...rest] = sorted
  const memoryKb = metric?.memoryKb ?? null
  const cpu = metric?.cpu ?? null
  if (first === undefined) throw new Error('a row needs a page')
  const named = child(first, 0)
  return {
    ...named,
    pid,
    memoryKb,
    cpu,
    // A process that also hosts one of Orivon's own views is never ended: that would take the window's UI with it.
    endable: metric !== undefined && sorted.every((entry) => ENDABLE_KINDS.has(entry.kind)),
    children: rest.map((entry, index) => child(entry, index + 1))
  }
}

function processRow (metric: MetricInput, entries: readonly ContentsInput[]): TaskRow {
  if (metric.type === 'Tab' && entries.length > 0) return row(metric.pid, metric, entries)
  const service = metric.name ?? metric.serviceName ?? ''
  const kind: TaskKind = metric.type === 'Browser' ? 'browser' : metric.type === 'GPU' ? 'gpu' : metric.type === 'Utility' ? 'utility' : 'other'
  const name = kind === 'other' ? (service !== '' ? service : metric.type === 'Tab' ? '' : metric.type) : service
  return {
    key: `p:${metric.pid}`,
    pid: metric.pid,
    kind,
    name: labelFor(kind, name === '' && kind === 'utility' ? 'Service' : name),
    memoryKb: metric.memoryKb,
    cpu: metric.cpu,
    endable: kind === 'utility',
    children: []
  }
}

/** Every process once, named by what it shows; then the pages that have no process at all. */
export function buildTasks (metrics: readonly MetricInput[], contents: readonly ContentsInput[]): TaskRow[] {
  const running = new Set(metrics.map((metric) => metric.pid))
  const byPid = new Map<number, ContentsInput[]>()
  const idle: ContentsInput[] = []
  for (const entry of contents) {
    if (entry.pid === 0 || !running.has(entry.pid)) {
      idle.push(entry)
      continue
    }
    byPid.set(entry.pid, [...(byPid.get(entry.pid) ?? []), entry])
  }
  const rows = metrics.map((metric) => processRow(metric, byPid.get(metric.pid) ?? []))
  for (const entry of idle) {
    if (entry.kind !== 'tab' && entry.kind !== 'app') continue
    const named = child(entry, 0)
    rows.push({ ...named, name: `${named.name} (not running)`, pid: 0, memoryKb: null, cpu: null, endable: false, children: [] })
  }
  return rows
}

export function totalsOf (rows: readonly TaskRow[]): TaskTotals {
  let memoryKb = 0
  let cpu = 0
  let cpuKnown = false
  for (const item of rows) {
    memoryKb += item.memoryKb ?? 0
    if (item.cpu !== null) {
      cpu += item.cpu
      cpuKnown = true
    }
  }
  return { memoryKb, cpu: cpuKnown ? cpu : null }
}

/** Whether the process `pid` may be ended: it is in the fresh rows, and of a kind that can be. */
export function canEnd (rows: readonly TaskRow[], pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  return rows.some((item) => item.pid === pid && item.endable)
}
