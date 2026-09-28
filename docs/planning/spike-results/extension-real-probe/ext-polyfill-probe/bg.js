const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const status = {}
async function check () {
  await delay(300)
  status.dnrExisted = typeof chrome.declarativeNetRequest
  status.dnrProbeValue = chrome.declarativeNetRequest ? chrome.declarativeNetRequest.__probe : 'no-dnr'
  status.sidePanelType = typeof chrome.sidePanel
  status.sidePanelPolyfilled = chrome.sidePanel ? !!chrome.sidePanel.__polyfilled : false
  status.ready = true
}
const checkDone = check()
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.kind === 'polyfill-status') { checkDone.then(() => sendResponse(status)); return true }
})
