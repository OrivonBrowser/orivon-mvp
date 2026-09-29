// MAIN-world content script, document_start (case 2, start). Skipped on a
// tamper-variant page (?t=a..e): main-start-tamper.js covers those.
;(function () {
  if (/[?&]t=[a-e]\b/.test(location.search)) return
  var t = location.pathname + '|case2-start'
  try { window.probeA && window.probeA.call(t + '.A') } catch (e) {}
  try { window.probeB && window.probeB.call(t + '.B') } catch (e) {}
  try { window.probeM && window.probeM.call(t + '.M') } catch (e) {}
})()
