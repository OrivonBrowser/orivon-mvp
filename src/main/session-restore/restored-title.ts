// A tab brought back shows the title it had while its page is still loading; the page's own title replaces it
// the moment there is one.
import type { WebContents } from 'electron'
import type { TabSignal } from '../shell/tab-signals.js'
import type { TabRecord, TabState } from '../shell/tab-types.js'

const shown = new WeakMap<TabRecord, string>()

/** Shows `title` for `record` until its page has one of its own. */
export function showTitleUntilLoaded (record: TabRecord, title: string): void {
  if (title.length > 0) shown.set(record, title)
}

export const restoredTitle: TabSignal = {
  name: 'restored-title',
  state: (record: TabRecord, wc: WebContents | undefined): Partial<TabState> => {
    const title = shown.get(record)
    if (title === undefined) return {}
    if (wc !== undefined && wc.getTitle() !== '') {
      shown.delete(record)
      return {}
    }
    return { title }
  }
}
