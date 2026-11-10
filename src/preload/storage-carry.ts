import { ipcRenderer } from 'electron'
import { STORAGE_CARRY_PORT_CHANNEL, STORAGE_CARRY_PORT_MESSAGE } from '../main/channels.js'

// Loaded ONLY by a hidden page of the storage carry (src/main/storage-carry/carry-pages.ts). It exposes nothing: when main
// sends the port that joins the two hidden pages, it posts it to its own page in a message that names the carry's nonce,
// where the carry's script takes it. It acts only in the top frame and only while its document is at the address main
// gave it, so a page the empty document was navigated away from never receives a port.
const URL_PREFIX = '--orivon-storage-carry-url='
const expectedUrl = process.argv.find((arg) => arg.startsWith(URL_PREFIX))?.slice(URL_PREFIX.length)

if (expectedUrl !== undefined && window === window.top && location.href === expectedUrl) {
  ipcRenderer.on(STORAGE_CARRY_PORT_CHANNEL, (event, nonce: unknown) => {
    if (typeof nonce !== 'string' || event.ports.length !== 1 || location.href !== expectedUrl) return
    window.postMessage(`${STORAGE_CARRY_PORT_MESSAGE}${nonce}`, '*', [...event.ports])
  })
}
