// Isolated content script (document_start). Cannot see window.probeA/B
// (measured already: an isolated content script never sees window.orivon
// either). Its job here: case 3, insert a web-accessible-resource
// <script src="chrome-extension://...">, and kick off the SW battery
// (case 4) by messaging the service worker with this tab's id.
;(function () {
  if (/[?&]t=[a-e]\b/.test(location.search)) return
  try {
    var s = document.createElement('script')
    s.src = chrome.runtime.getURL('war.js')
    document.documentElement.appendChild(s)
  } catch (e) {}

  try {
    chrome.runtime.sendMessage({ kind: 'run-sw-battery', pathname: location.pathname })
      .then(function (r) { try { console.log('[probe] sw-battery reply ' + location.pathname + ': ' + JSON.stringify(r)) } catch (e) {} })
      .catch(function (e) { try { console.log('[probe] sw-battery err ' + location.pathname + ': ' + String(e)) } catch (e2) {} })
  } catch (e) {}
})()
