// Reads the running processes and what each one shows, ends one on request,
// and takes the person to a tab. The decisions (names, what may be ended) are
// tasks-model.ts's; everything here touches live Electron objects.
import { app, webContents as allContents } from 'electron'
import type { WebContents } from 'electron'
import { markEndedOnPurpose, takeEndedOnPurpose } from '../diagnostics/crash-lookup.js'
import { appTabViews } from '../shell/tab-partition.js'
import type { WindowRegistry } from '../shell/window-registry.js'
import { buildTasks, canEnd, totalsOf } from './tasks-model.js'
import type { ContentsInput, MetricInput, TaskRow, TaskTotals } from './tasks-model.js'

export interface TasksEnv {
  readonly windows: Pick<WindowRegistry, 'all' | 'findTab' | 'findOwner'>
  /** An installed extension's name, by the id in its `chrome-extension://` address. */
  readonly extensionName: (id: string) => string | undefined
}

interface Gathered {
  readonly metrics: MetricInput[]
  readonly entries: Array<ContentsInput & { readonly contents: WebContents | undefined }>
}

/** Electron reports 0 CPU for a process until a second reading; a gap this long means the next one is a first. */
const CPU_WARM_MS = 10_000
let lastSample = 0

function processIdOf (contents: WebContents): number {
  if (contents.isDestroyed() || contents.isCrashed()) return 0
  try {
    return contents.getOSProcessId()
  } catch {
    return 0
  }
}

function hostOf (url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function gatherMetrics (): MetricInput[] {
  const warm = Date.now() - lastSample < CPU_WARM_MS
  lastSample = Date.now()
  return app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    cpu: warm ? metric.cpu.percentCPUUsage : null,
    memoryKb: metric.memory.workingSetSize,
    name: metric.name,
    serviceName: metric.serviceName
  }))
}

function gatherContents (env: TasksEnv): Gathered['entries'] {
  const entries: Gathered['entries'] = []
  const seen = new Set<WebContents>()
  for (const shell of env.windows.all()) {
    if (shell.window.isDestroyed()) continue
    for (const id of shell.tabs.ids()) {
      const record = shell.tabs.record(id)
      const contents = shell.tabs.liveWebContents(id)
      if (record === undefined || contents === undefined) continue
      seen.add(contents)
      const title = record.sleeping?.title ?? contents.getTitle()
      const isApp = appTabViews.has(record.view)
      entries.push({
        pid: processIdOf(contents),
        kind: record.internalPage !== null ? 'internal' : isApp ? 'app' : 'tab',
        name: record.internalPage !== null ? (title !== '' ? title : record.internalPage) : isApp ? hostOf(contents.getURL()) : (title !== '' ? title : hostOf(record.sleeping?.url ?? contents.getURL())),
        tabId: id,
        favicon: record.favicon,
        contents
      })
    }
    seen.add(shell.chrome.webContents)
    entries.push({ pid: processIdOf(shell.chrome.webContents), kind: 'shell', name: '', contents: shell.chrome.webContents })
  }
  for (const contents of allContents.getAllWebContents()) {
    if (seen.has(contents) || contents.isDestroyed()) continue
    const url = contents.getURL()
    if (url.startsWith('chrome-extension://')) {
      const id = hostOf(url)
      entries.push({ pid: processIdOf(contents), kind: 'extension', name: env.extensionName(id) ?? id, contents })
    } else if (env.windows.findOwner(contents) !== undefined) {
      entries.push({ pid: processIdOf(contents), kind: 'overlay', name: '', contents })
    }
  }
  return entries
}

function gather (env: TasksEnv): Gathered {
  return { metrics: gatherMetrics(), entries: gatherContents(env) }
}

export function listTasks (env: TasksEnv): { rows: TaskRow[], totals: TaskTotals } {
  const { metrics, entries } = gather(env)
  const rows = buildTasks(metrics, entries)
  return { rows, totals: totalsOf(rows) }
}

/** Ends `pid` if, in a fresh reading, it is a process of Orivon's own that may be ended. Whether it was. */
export function endProcess (env: TasksEnv, pid: unknown): boolean {
  const { metrics, entries } = gather(env)
  if (!canEnd(buildTasks(metrics, entries), pid) || typeof pid !== 'number') return false
  // Through the page that main found in that process, never a signal to the number: a process id the system has
  // already given to something else is then never touched.
  const hosted = entries.find((entry) => entry.pid === pid && entry.contents !== undefined && !entry.contents.isDestroyed())?.contents
  if (hosted === undefined) return false
  markEndedOnPurpose(hosted.id)
  try {
    hosted.forcefullyCrashRenderer()
    return true
  } catch {
    takeEndedOnPurpose(hosted.id)
    return false
  }
}

/** Activates a tab in whichever window holds it, and brings that window forward when it is not the asker's. */
export function focusTab (env: TasksEnv, tabId: unknown, from: WebContents): boolean {
  if (typeof tabId !== 'string') return false
  const asker = env.windows.findTab(from)?.window
  for (const shell of env.windows.all()) {
    if (shell.window.isDestroyed() || !shell.tabs.ids().includes(tabId)) continue
    shell.tabs.activateTab(tabId)
    if (shell !== asker) {
      if (shell.window.isMinimized()) shell.window.restore()
      shell.window.focus()
    }
    return true
  }
  return false
}
