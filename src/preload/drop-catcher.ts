import { ipcRenderer } from 'electron'
import { DROP_CATCHER_CHANNEL, TAB_DRAG_TYPE } from '../main/channels.js'

// Loaded ONLY by a window's drop catcher (src/main/shell/drop-catcher.ts), a transparent view laid over the page
// while a tab is dragged. It exposes nothing to its page: it listens for the drag's events on the document itself
// and tells main where they were, so a page under the drag sees no event at all. It acts only on a drag that
// carries the tab type, and only while its document is at the address main gave it.
const URL_PREFIX = '--orivon-drop-catcher-url='
const expectedUrl = process.argv.find((arg) => arg.startsWith(URL_PREFIX))?.slice(URL_PREFIX.length)

if (expectedUrl !== undefined && location.href === expectedUrl) {
  const carriesTab = (event: DragEvent): boolean => event.dataTransfer?.types.includes(TAB_DRAG_TYPE) === true
  const report = (message: object): void => { ipcRenderer.send(DROP_CATCHER_CHANNEL, message) }
  let last = ''
  const over = (event: DragEvent): void => {
    if (!carriesTab(event)) return
    event.preventDefault()
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
    const at = `${String(event.clientX)},${String(event.clientY)}`
    if (at === last) return
    last = at
    report({ type: 'over', x: event.clientX, y: event.clientY })
  }
  document.addEventListener('dragenter', over, true)
  document.addEventListener('dragover', over, true)
  document.addEventListener('dragleave', (event) => {
    if (!carriesTab(event)) return
    last = ''
    report({ type: 'leave' })
  }, true)
  document.addEventListener('drop', (event) => {
    if (!carriesTab(event)) return
    event.preventDefault()
    last = ''
    report({ type: 'drop', nonce: event.dataTransfer?.getData(TAB_DRAG_TYPE) ?? '', x: event.clientX, y: event.clientY })
  }, true)
}
