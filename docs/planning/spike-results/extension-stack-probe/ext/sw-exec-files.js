// Executed in the MAIN world by chrome.scripting.executeScript({ world:
// 'MAIN', files: [...] }) from the service worker (case 4, files variant).
;(function () {
  var t = location.pathname + '|case4-exec-files'
  try { window.probeA && window.probeA.call(t + '.A') } catch (e) {}
  try { window.probeB && window.probeB.call(t + '.B') } catch (e) {}
  try { window.probeM && window.probeM.call(t + '.M') } catch (e) {}
})()
