// What the task manager page may ask of main: the current rows, to end a
// process, and to go to a tab. The page names a process by number and a tab
// by id, and both are looked up in main's own fresh reading before anything
// acts on them.
import type { InternalCaller, InternalDomain } from '../pages/internal-ipc.js'
import type { TaskRow, TaskTotals } from './tasks-model.js'

export interface TasksDomainDeps {
  readonly list: () => { rows: TaskRow[], totals: TaskTotals }
  readonly end: (pid: unknown) => boolean
  readonly focus: (tabId: unknown, caller: InternalCaller) => boolean
}

export function tasksDomain (deps: TasksDomainDeps): InternalDomain {
  return {
    pages: ['tasks'],
    handle: (command, caller) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as { type?: unknown, pid?: unknown, tabId?: unknown }
      switch (request.type) {
        case 'list': return deps.list()
        case 'end': return { ok: deps.end(request.pid) }
        case 'focus': return { ok: deps.focus(request.tabId, caller) }
        default: return undefined
      }
    }
  }
}
