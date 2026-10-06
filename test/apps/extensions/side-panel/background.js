// Logs what the browser tells this extension about its panel and its toolbar button, and answers `__log` and
// `__clear` through rpc.js. The test reads the log; nothing here opens a panel by itself.
importScripts('rpc.js')

const log = []
globalThis.__log = () => log.slice()
globalThis.__clear = () => { log.length = 0 }

// With `__arm(true)` a toolbar click with no popup asks for the panel from inside onClicked, as an extension does.
let armed = false
globalThis.__arm = (value) => { armed = value === true }

chrome.action.onClicked.addListener((tab) => {
  log.push({ event: 'onClicked' })
  if (!armed) return
  chrome.sidePanel.open({ windowId: tab.windowId })
    .then(() => { log.push({ event: 'opened-from-onClicked' }) })
    .catch((error) => { log.push({ event: 'open-failed', error: String(error && error.message ? error.message : error) }) })
})
chrome.sidePanel.onOpened.addListener((info) => { log.push({ event: 'onOpened', info }) })
chrome.sidePanel.onClosed.addListener((info) => { log.push({ event: 'onClosed', info }) })
