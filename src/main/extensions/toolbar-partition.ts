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

/** What the page is sent: `partition`'s script, remembered, and again once a page that reloaded has loaded. */
export function syncToolbarPartition (chrome: Pick<WebContents, 'executeJavaScript' | 'isDestroyed'> & Partial<Pick<WebContents, 'on'>>, partition: string): void {
  if (chrome.isDestroyed()) return
  const first = !last.has(chrome)
  if (last.get(chrome) === partition) return
  const script = partitionScript(partition)
  if (script === null) return
  last.set(chrome, partition)
  // A chrome page that reloads draws its list at the default session again; it is told once more what it showed.
  if (first) {
    chrome.on?.('did-finish-load', () => {
      const wanted = last.get(chrome)
      const again = wanted === undefined ? null : partitionScript(wanted)
      if (again !== null && !chrome.isDestroyed()) chrome.executeJavaScript(again).catch(() => undefined)
    })
  }
  chrome.executeJavaScript(script).catch(() => {
    // The chrome page is reloading: the load that ends it sends it again.
  })
}
