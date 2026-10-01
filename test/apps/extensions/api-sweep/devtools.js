// Runs in the DevTools frontend's own subframe: records whether
// chrome.devtools.panels.create called back, for the test to read from the
// service worker through chrome.storage.
const outcome = { reachable: typeof chrome.devtools === 'object' && chrome.devtools !== null, created: false }
function record () { chrome.storage.local.set({ devtoolsPanel: outcome }) }
if (outcome.reachable && chrome.devtools.panels && typeof chrome.devtools.panels.create === 'function') {
  chrome.devtools.panels.create('Sweep', '', 'page.html', () => { outcome.created = true; record() })
}
record()
