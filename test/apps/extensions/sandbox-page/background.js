// Opens its own sandbox page, and a framer page that puts the SAME
// sandbox page inside an iframe, as tabs on its own initiative, right when
// the service worker starts -- the e2e test never needs to command it
// (test/e2e-extensions-sandbox-page.test.ts's own header says why: a
// sandboxed page has no chrome.* to drive from the test's own extension
// popup pattern, so opening it from the extension's own code is the
// simplest reliable trigger).
chrome.tabs.create({ url: chrome.runtime.getURL('sandbox.html') })
chrome.tabs.create({ url: chrome.runtime.getURL('framer.html') })
