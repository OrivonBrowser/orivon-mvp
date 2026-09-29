// Served at /page.js -- the page's own external script (case 1 baseline).
try { window.probeA && window.probeA.call('case1-external.A') } catch (e) {}
try { window.probeB && window.probeB.call('case1-external.B') } catch (e) {}
try { window.probeM && window.probeM.call('case1-external.M') } catch (e) {}

// A page-defined function extension code can call directly, or hand to a
// scheduler (case 6). Tags itself with a call counter so the direct call
// and the setTimeout-scheduled call are distinguishable.
window.pageHelper = function () {
  window.__pageHelperN = (window.__pageHelperN || 0) + 1
  var n = window.__pageHelperN
  try { window.probeA && window.probeA.call(location.pathname + '|case6-pagehelper-' + n + '.A') } catch (e) {}
  try { window.probeB && window.probeB.call(location.pathname + '|case6-pagehelper-' + n + '.B') } catch (e) {}
  try { window.probeM && window.probeM.call(location.pathname + '|case6-pagehelper-' + n + '.M') } catch (e) {}
}
