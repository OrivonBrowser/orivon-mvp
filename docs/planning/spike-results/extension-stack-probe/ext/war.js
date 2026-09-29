// Web-accessible resource (case 3): loaded by a <script src="chrome-extension://...">
// tag the isolated content script inserted into the page. Script tags always
// run in the page's MAIN world, whoever inserted the DOM node.
;(function () {
  var t = location.pathname + '|case3-war'
  try { window.probeA && window.probeA.call(t + '.A') } catch (e) {}
  try { window.probeB && window.probeB.call(t + '.B') } catch (e) {}
  try { window.probeM && window.probeM.call(t + '.M') } catch (e) {}
})()
