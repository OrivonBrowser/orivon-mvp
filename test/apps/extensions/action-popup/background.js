// Fixture service worker for test/extensions/e2e-extensions-toolbar.test.ts: on a
// message, runs chrome.tabs.query and chrome.tabs.create and replies with
// the result -- the MV3 shape test/extensions/e2e-extensions-toolbar.test.ts's own
// header describes. Not the e2e test's primary path (its own header notes
// why); kept as a realistic MV3 worker a future investigation can drive
// once electron-chrome-extensions' 'service-worker'-type preload injection
// is confirmed working end to end here.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.cmd === 'query') {
      const tabs = await chrome.tabs.query({})
      sendResponse({ tabs: tabs.map((tab) => ({ id: tab.id, url: tab.url })) })
    } else if (message.cmd === 'create') {
      try {
        const tab = await chrome.tabs.create({ url: message.url })
        sendResponse({ ok: true, tab: { id: tab.id, url: tab.url } })
      } catch (error) {
        sendResponse({ ok: false, error: String(error) })
      }
    }
  })()
  return true
})
