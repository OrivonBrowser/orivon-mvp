// MAIN-world content script (manifest.json's own "world": "MAIN" entry),
// run_at document_start -- before the page's own scripts, matching the
// probe's own case2-start.M timing. Reports every outcome into
// document.documentElement's dataset, which the test reads back from the
// isolated world (dataset survives the world boundary; window.orivon does
// not).
//
// Which scenario runs is selected by the fixture page's own path
// (test/e2e-extensions-orivon-filter.test.ts's own server): every scenario
// below calls the SAME harmless, already-registered method, orivon.app.
// manifest().
(function () {
  function report (name, outcome) {
    document.documentElement.setAttribute('data-orivon-' + name, outcome)
  }

  function outcomeOf (error) {
    return (error && typeof error === 'object' && typeof error.code === 'string') ? error.code : String(error)
  }

  async function call (name) {
    try {
      await window.orivon.app.manifest()
      report(name, 'allowed')
    } catch (error) {
      report(name, outcomeOf(error))
    }
  }

  if (location.pathname === '/orivon-fixture/deferred') {
    // A deferred bound call: `.bind()` produces a plain function, called
    // later from inside setTimeout's own callback with no caller frame of
    // its own -- the brief's own worked case. The `.then`/`.catch` here is
    // reporting plumbing only, not what is under test: the STACK at the
    // moment the bound call actually runs is what main-world-socket.ts's
    // check sees, fixed by where `.bind()`'s target was defined, never by
    // this wrapper.
    const bound = window.orivon.app.manifest.bind(window.orivon.app)
    setTimeout(() => { bound().then(() => { report('deferred', 'allowed') }, (error) => { report('deferred', outcomeOf(error)) }) }, 20)
    return
  }

  if (location.pathname === '/orivon-fixture/sourceurl') {
    // Bypass 3's own worked case: a `//# sourceURL=...` comment on a STRING
    // passed to setTimeout claims a page URL for code that is really the
    // extension's own -- main-world-socket.ts's isPage check must never
    // read scriptNameOrSourceURL for page attribution (README.md's Design
    // notes), so this must still refuse. String-eval'd code runs in the
    // global scope, not this IIFE's closure -- everything it needs is
    // inlined rather than reaching for report()/outcomeOf() above.
    setTimeout(
      "window.orivon.app.manifest().then(function () { document.documentElement.setAttribute('data-orivon-sourceurl', 'allowed') }, " +
      "function (e) { document.documentElement.setAttribute('data-orivon-sourceurl', (e && typeof e === 'object' && typeof e.code === 'string') ? e.code : String(e)) })\n" +
      '//# sourceURL=' + location.origin + '/spoofed-page.js',
      20
    )
    return
  }

  if (location.pathname === '/orivon-fixture/tamper') {
    // Freezes the stack-capture machinery before ANY script on this page
    // runs, document_start's own guarantee -- main-world-socket.ts's own
    // check must refuse every call on this page from here on, the page's
    // own included, not just this extension's.
    try {
      Object.defineProperty(Error, 'stackTraceLimit', { value: 0, writable: false, configurable: false })
    } catch (error) { /* already unconfigurable; the effect is the same */ }
    void call('tamper-extension')
    return
  }

  void call('main-world')
})()
