// A wallet's way of asking the person to approve a page's request, as a real wallet does it: ask the page's content
// script whether the person just acted (giving up after 500 ms), open the side panel from the answer, and otherwise show
// one popup window, found again by type and id for the next request, forgotten when the window is removed.
importScripts('rpc.js')

const log = []
globalThis.__log = () => log.slice()
globalThis.__clear = () => { log.length = 0 }

const SIDE_PANEL_ANSWER_MS = 500
const LEFT = 120
const TOP = 80

let popupId
const waiting = new Map()

chrome.windows.onRemoved.addListener((id) => {
  log.push({ event: 'window-removed', id })
  if (id === popupId) popupId = undefined
})

async function showPopup () {
  const existing = (await chrome.windows.getAll()).find((w) => w.type === 'popup' && w.id === popupId)
  if (existing) {
    await chrome.windows.update(existing.id, { focused: true })
    log.push({ event: 'popup-refocused', id: existing.id })
    return
  }
  const created = await chrome.windows.create({ url: 'popup.html', type: 'popup', width: 400, height: 620, left: LEFT, top: TOP })
  popupId = created.id
  log.push({ event: 'popup-created', id: created.id, type: created.type, left: created.left, top: created.top, width: created.width, height: created.height })
  if (created.left !== LEFT && created.state !== 'fullscreen') await chrome.windows.update(created.id, { left: LEFT, top: TOP })
}

function askSidePanel (tabId) {
  return new Promise((resolve) => {
    const nonce = String(Math.random())
    const done = (opened) => { clearTimeout(timer); waiting.delete(nonce); resolve(opened) }
    const timer = setTimeout(() => { log.push({ event: 'side-panel-unanswered' }); done(false) }, SIDE_PANEL_ANSWER_MS)
    waiting.set(nonce, done)
    chrome.tabs.sendMessage(tabId, { type: 'REQUEST_OPEN_SIDEPANEL', nonce })
      .then(() => { log.push({ event: 'content-script-reached' }) })
      .catch((error) => { log.push({ event: 'content-script-unreachable', error: String(error && error.message ? error.message : error) }) })
  })
}

async function showUi (tabId) {
  if (await askSidePanel(tabId)) return
  await showPopup()
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'dapp-request') {
    log.push({ event: 'dapp-request', senderTabId: sender.tab ? sender.tab.id : null })
    if (sender.tab) showUi(sender.tab.id).catch((error) => { log.push({ event: 'show-failed', error: String(error && error.message ? error.message : error) }) })
    return false
  }
  if (message && message.type === 'OPEN_SIDEPANEL') {
    log.push({ event: 'open-sidepanel-message', senderTabId: sender.tab ? sender.tab.id : null })
    const done = waiting.get(message.nonce)
    if (!done || !sender.tab) return false
    // Called in the listener itself, as the wallet does: the message stands for the person's click.
    chrome.sidePanel.open({ tabId: sender.tab.id })
      .then(() => { log.push({ event: 'side-panel-opened' }); done(true) })
      .catch((error) => { log.push({ event: 'side-panel-refused', error: String(error && error.message ? error.message : error) }); done(false) })
  }
  return false
})
