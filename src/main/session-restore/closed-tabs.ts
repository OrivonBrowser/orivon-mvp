// Puts a tab the person closed on the closed stack. Only `closed` counts: a tab that crashed, went to another
// window alive, or went with its window is not one they closed.
import type { TabLifecycle } from '../shell/tab-lifecycle.js'
import type { ClosedStack } from './closed-stack.js'
import { snapshotOf } from './tab-snapshot.js'
import type { TabSnapshot } from './tab-snapshot.js'

type Snapshot = (record: Parameters<typeof snapshotOf>[0], wc: Parameters<typeof snapshotOf>[1]) => TabSnapshot | null

/** Returns the removal. `snapshot` is a seam for tests. */
export function watchClosedTabs (lifecycle: TabLifecycle, stack: ClosedStack, snapshot: Snapshot = snapshotOf): () => void {
  return lifecycle.subscribe({
    tabClosing: ({ reason, record, index, window }) => {
      if (reason !== 'closed') return
      const tab = snapshot(record, record.view.webContents)
      if (tab !== null) stack.push({ kind: 'tab', tab, index, windowKey: window?.id ?? -1 })
    }
  })
}
