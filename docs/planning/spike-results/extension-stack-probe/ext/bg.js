// MV3 service worker. On a message from the isolated content script, runs
// the case-4 battery: chrome.scripting.executeScript with an inline func
// and with files, plus registerContentScripts (which only affects a FUTURE
// navigation/reload of the tab, not the one already loaded).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.kind !== 'run-sw-battery') return
  const tabId = sender.tab && sender.tab.id
  if (tabId == null) { sendResponse({ ok: false, reason: 'no tabId' }); return }
  const pathname = msg.pathname

  const p1 = chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (t) => {
      try { window.probeA && window.probeA.call(t + '.A') } catch (e) {}
      try { window.probeB && window.probeB.call(t + '.B') } catch (e) {}
      try { window.probeM && window.probeM.call(t + '.M') } catch (e) {}
    },
    args: [pathname + '|case4-exec-func']
  }).catch((e) => ({ error: String(e) }))

  const p2 = chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['sw-exec-files.js']
  }).catch((e) => ({ error: String(e) }))

  const p3 = chrome.scripting.registerContentScripts([{
    id: 'reg-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    matches: ['<all_urls>'],
    world: 'MAIN',
    js: ['sw-registered.js'],
    runAt: 'document_idle'
  }]).catch((e) => ({ error: String(e) }))

  Promise.all([p1, p2, p3]).then((r) => sendResponse({ ok: true, r: r.map((x) => String(x)) }))
  return true
})
