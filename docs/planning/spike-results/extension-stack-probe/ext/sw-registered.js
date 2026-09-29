// Registered via chrome.scripting.registerContentScripts({ world: 'MAIN',
// ... }) from the service worker (case 4, registerContentScripts variant).
// Only takes effect on the NEXT matching navigation/reload of a tab.
;(function () {
  var t = location.pathname + '|case4-registered'
  try { window.probeA && window.probeA.call(t + '.A') } catch (e) {}
  try { window.probeB && window.probeB.call(t + '.B') } catch (e) {}
  try { window.probeM && window.probeM.call(t + '.M') } catch (e) {}
})()
