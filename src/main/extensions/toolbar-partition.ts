// Which library instance the toolbar's extension buttons speak to. The list in a window's chrome page is addressed by the
// name of a session (`partition`); the buttons of an extension act on the active tab, so while a tab of a profile session is
// in front the list is moved to that session, and back to the default one for any other tab.
import type { WebContents } from 'electron'

/** The names of sessions: `orivon-extensions-default`, `persist:tunnel-profile`. */
const PARTITION_NAME = /^[A-Za-z0-9:_-]{1,64}$/

/** The script the chrome page runs. `partition` is checked before it is written into the source. */
export function partitionScript (partition: string): string | null {
  if (!PARTITION_NAME.test(partition)) return null
  return `(() => {
  const list = document.querySelector('browser-action-list')
  if (list && list.getAttribute('partition') !== '${partition}') list.setAttribute('partition', '${partition}')
})()`
}

const last = new WeakMap<object, string>()

/** Points the list in `chrome` at `partition`; a page reloading is told again the next time a tab comes to the front. */
export function syncToolbarPartition (chrome: Pick<WebContents, 'executeJavaScript' | 'isDestroyed'>, partition: string): void {
  if (chrome.isDestroyed() || last.get(chrome) === partition) return
  const script = partitionScript(partition)
  if (script === null) return
  last.set(chrome, partition)
  chrome.executeJavaScript(script).catch(() => {
    // The chrome page is reloading: forget what was sent so that the next tab to the front sends it again.
    last.delete(chrome)
  })
}
