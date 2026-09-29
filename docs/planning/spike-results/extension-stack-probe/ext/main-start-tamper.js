// MAIN-world content script, document_start. Only acts on a page loaded
// with ?t=a..e -- applies exactly ONE tamper to the main-world Error
// (matching probeM's own realm), then calls all three probes once so the
// effect on each is comparable. Runs after preload installs probeA/B/M
// (measured in the earlier probe: a document_start MAIN content script
// already sees window.orivon/probeX present), so the tamper always lands
// after install and only affects what happens from here on.
;(function () {
  var m = /[?&]t=([a-e])\b/.exec(location.search)
  if (!m) return
  var t = m[1]
  var label = 'case9-tamper-' + t

  try {
    if (t === 'a') {
      // (a) Make Error.prepareStackTrace a non-configurable accessor that
      // always answers with a fake hook -- our own redefinition attempt
      // must fail.
      Object.defineProperty(Error, 'prepareStackTrace', {
        get: function () { return function () { return 'fake' } },
        configurable: false
      })
    } else if (t === 'b') {
      // (b) Ordinary writable/configurable reassignment to a hook that
      // reports zero frames -- our own redefinition should simply
      // overwrite it before capturing.
      Error.prepareStackTrace = function (_e, _s) { return [] }
    } else if (t === 'c') {
      // (c) Replace the global Error binding entirely. probeM's private
      // `E` was captured at install time and does not follow this.
      window.Error = function FakeError () {}
    } else if (t === 'd') {
      // (d) stackTraceLimit = 0, still writable/configurable -- probeM
      // should be able to raise it back around its own capture.
      Error.stackTraceLimit = 0
    } else if (t === 'e') {
      // (e) stackTraceLimit frozen at 0 -- probeM's own defensive
      // redefinition must fail too; this is the one tamper cases (d)'s
      // defence cannot survive.
      Object.defineProperty(Error, 'stackTraceLimit', {
        value: 0, writable: false, configurable: false
      })
    }
  } catch (e) {}

  try { window.probeM && window.probeM.call(location.pathname + '|' + label + '.M') } catch (e) {}
  try { window.probeA && window.probeA.call(location.pathname + '|' + label + '.A') } catch (e) {}
  try { window.probeB && window.probeB.call(location.pathname + '|' + label + '.B') } catch (e) {}
})()
