// MAIN-world content script, document_idle. Runs the full battery: case
// 2 (idle), case 5 (laundering routes with an extension frame still on the
// stack), case 6 (laundering routes with NO extension frame left on the
// stack by the time the probe fires), and case 7 (tamper with Error in the
// main world, then call -- now meaningful for probeM too, since probeM
// captures IN this same main-world Error). Runs identically on the plain
// page and the strict-CSP page (case 8). Skipped on a tamper-variant page
// (?t=a..e): main-start-tamper.js covers those with a single, isolated
// tamper each.
;(function () {
  if (/[?&]t=[a-e]\b/.test(location.search)) return
  var base = location.pathname

  function callAll (name, opts) {
    var tag = base + '|' + name
    try { window.probeA && window.probeA.call(tag + '.A', opts) } catch (e) {}
    try { window.probeB && window.probeB.call(tag + '.B', opts) } catch (e) {}
    try { window.probeM && window.probeM.call(tag + '.M', opts) } catch (e) {}
  }

  // case 2, idle
  callAll('case2-idle')

  // case 5: laundering routes, extension frame still on the stack
  try {
    eval("window.probeA && window.probeA.call('" + base + "|case5-eval.A'); window.probeB && window.probeB.call('" + base + "|case5-eval.B'); window.probeM && window.probeM.call('" + base + "|case5-eval.M')")
  } catch (e) {}

  try {
    // eslint-disable-next-line no-new-func
    new Function("window.probeA && window.probeA.call('" + base + "|case5-newfunction.A'); window.probeB && window.probeB.call('" + base + "|case5-newfunction.B'); window.probeM && window.probeM.call('" + base + "|case5-newfunction.M')")()
  } catch (e) {}

  try {
    setTimeout("window.probeA && window.probeA.call('" + base + "|case5-settimeout-string.A'); window.probeB && window.probeB.call('" + base + "|case5-settimeout-string.B'); window.probeM && window.probeM.call('" + base + "|case5-settimeout-string.M')", 0)
  } catch (e) {}

  try {
    var s1 = document.createElement('script')
    s1.textContent = "window.probeA && window.probeA.call('" + base + "|case5-inline-el.A'); window.probeB && window.probeB.call('" + base + "|case5-inline-el.B'); window.probeM && window.probeM.call('" + base + "|case5-inline-el.M')"
    document.documentElement.appendChild(s1)
    s1.remove()
  } catch (e) {}

  try {
    var code2 = "window.probeA && window.probeA.call('" + base + "|case5-blob.A'); window.probeB && window.probeB.call('" + base + "|case5-blob.B'); window.probeM && window.probeM.call('" + base + "|case5-blob.M')"
    var blob = new Blob([code2], { type: 'text/javascript' })
    var burl = URL.createObjectURL(blob)
    var s2 = document.createElement('script')
    s2.src = burl
    document.documentElement.appendChild(s2)
  } catch (e) {}

  try {
    var code3 = "window.probeA && window.probeA.call('" + base + "|case5-data.A'); window.probeB && window.probeB.call('" + base + "|case5-data.B'); window.probeM && window.probeM.call('" + base + "|case5-data.M')"
    var s3 = document.createElement('script')
    s3.src = 'data:text/javascript,' + encodeURIComponent(code3)
    document.documentElement.appendChild(s3)
  } catch (e) {}

  try {
    var btn1 = document.createElement('button')
    btn1.setAttribute('onclick', "window.probeA && window.probeA.call('" + base + "|case5-onclick.A'); window.probeB && window.probeB.call('" + base + "|case5-onclick.B'); window.probeM && window.probeM.call('" + base + "|case5-onclick.M')")
    document.body.appendChild(btn1)
    btn1.click()
  } catch (e) {}

  try {
    // A javascript: URL assigned to `location` runs in place (no string is
    // returned, so no navigation actually happens) -- kept last-ish so a
    // surprise navigation cannot cut off the routes below.
    location = "javascript:(function(){window.probeA && window.probeA.call('" + base + "|case5-location-js.A'); window.probeB && window.probeB.call('" + base + "|case5-location-js.B'); window.probeM && window.probeM.call('" + base + "|case5-location-js.M')})();void 0"
  } catch (e) {}

  // case 6: no extension-authored frame left on the stack by the time the
  // probe actually fires -- everything is scheduled/bound, not called
  // directly from extension code.
  var callA = window.probeA && window.probeA.call.bind(window.probeA)
  var callB = window.probeB && window.probeB.call.bind(window.probeB)
  var callM = window.probeM && window.probeM.call.bind(window.probeM)

  try { if (callA) setTimeout(callA.bind(null, base + '|case6-bound-timer.A')) } catch (e) {}
  try { if (callB) setTimeout(callB.bind(null, base + '|case6-bound-timer.B')) } catch (e) {}
  try { if (callM) setTimeout(callM.bind(null, base + '|case6-bound-timer.M')) } catch (e) {}

  try { if (callA) Promise.resolve().then(callA.bind(null, base + '|case6-bound-microtask.A')) } catch (e) {}
  try { if (callB) Promise.resolve().then(callB.bind(null, base + '|case6-bound-microtask.B')) } catch (e) {}
  try { if (callM) Promise.resolve().then(callM.bind(null, base + '|case6-bound-microtask.M')) } catch (e) {}

  try {
    var btn2 = document.createElement('button')
    document.body.appendChild(btn2)
    if (callA) btn2.addEventListener('click', callA.bind(null, base + '|case6-bound-listener.A'))
    if (callB) btn2.addEventListener('click', callB.bind(null, base + '|case6-bound-listener.B'))
    if (callM) btn2.addEventListener('click', callM.bind(null, base + '|case6-bound-listener.M'))
    btn2.click()
  } catch (e) {}

  try { if (callA) queueMicrotask(callA.bind(null, base + '|case6-queuemicrotask.A')) } catch (e) {}
  try { if (callB) queueMicrotask(callB.bind(null, base + '|case6-queuemicrotask.B')) } catch (e) {}
  try { if (callM) queueMicrotask(callM.bind(null, base + '|case6-queuemicrotask.M')) } catch (e) {}

  try { if (callA) requestAnimationFrame(callA.bind(null, base + '|case6-raf.A')) } catch (e) {}
  try { if (callB) requestAnimationFrame(callB.bind(null, base + '|case6-raf.B')) } catch (e) {}
  try { if (callM) requestAnimationFrame(callM.bind(null, base + '|case6-raf.M')) } catch (e) {}

  try {
    var target = document.createElement('div')
    document.body.appendChild(target)
    if (callA) {
      var moA = new MutationObserver(callA.bind(null, base + '|case6-mutationobserver.A'))
      moA.observe(target, { attributes: true })
    }
    if (callB) {
      var moB = new MutationObserver(callB.bind(null, base + '|case6-mutationobserver.B'))
      moB.observe(target, { attributes: true })
    }
    if (callM) {
      var moM = new MutationObserver(callM.bind(null, base + '|case6-mutationobserver.M'))
      moM.observe(target, { attributes: true })
    }
    target.setAttribute('data-x', '1')
  } catch (e) {}

  // page-defined function, called directly then scheduled -- pageHelper
  // (page.js) tags itself with an incrementing counter and calls all three
  // probes, so #1 is the direct call and #2 is the setTimeout-scheduled one.
  try { window.pageHelper && window.pageHelper() } catch (e) {}
  try { window.pageHelper && setTimeout(window.pageHelper) } catch (e) {}

  // case 7: tamper with Error in the MAIN world, then call. probeA/probeB
  // capture in the ISOLATED world (a different Error, unaffected either
  // way); probeM now captures IN THIS SAME main-world Error, so this is
  // the meaningful case for it -- combines tamper (b)-style hook and (d)-
  // style stackTraceLimit=0 in one shot, restored afterwards.
  try {
    var savedPST = Error.prepareStackTrace
    var savedLimit = Error.stackTraceLimit
    var savedCapture = Error.captureStackTrace
    Error.prepareStackTrace = function () { return 'fake' }
    Error.stackTraceLimit = 0
    Error.captureStackTrace = function (o) { o.stack = 'tampered' }
    callAll('case7-tamper')
    Error.prepareStackTrace = savedPST
    Error.stackTraceLimit = savedLimit
    Error.captureStackTrace = savedCapture
  } catch (e) {}

  // case 7: ask each probe to raise its OWN stackTraceLimit for this one
  // capture and see whether deeper frames appear.
  callAll('case7-deep-limit', { deep: true })
})()
