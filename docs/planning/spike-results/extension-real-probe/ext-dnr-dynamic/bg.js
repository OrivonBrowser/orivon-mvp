const status = { dynamicAdd: null, sessionAdd: null, getDynamic: null, getSession: null }
async function setup () {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{ id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: '/probe-block/dynamic.js', resourceTypes: ['script'] } }]
    })
    status.dynamicAdd = 'resolved'
  } catch (e) { status.dynamicAdd = 'threw:' + String(e && e.message || e) }
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [{ id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: '/probe-block/session.js', resourceTypes: ['script'] } }]
    })
    status.sessionAdd = 'resolved'
  } catch (e) { status.sessionAdd = 'threw:' + String(e && e.message || e) }
  try { status.getDynamic = JSON.stringify(await chrome.declarativeNetRequest.getDynamicRules()) } catch (e) { status.getDynamic = 'threw:' + String(e && e.message || e) }
  try { status.getSession = JSON.stringify(await chrome.declarativeNetRequest.getSessionRules()) } catch (e) { status.getSession = 'threw:' + String(e && e.message || e) }
  status.ready = true
}
const setupDone = setup()
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.kind === 'dnr-status') {
    setupDone.then(() => sendResponse(status))
    return true
  }
})
