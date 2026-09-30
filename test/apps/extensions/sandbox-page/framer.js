// An ordinary (non-sandboxed) extension page, framing the SAME sandbox.html
// the fixture also opens directly as a tab -- its own chrome.* is the
// baseline the sandboxed iframe's own attempt to reach `parent.chrome`
// (sandbox.js) is a bypass of, if it succeeds.
document.documentElement.dataset.hasChrome = String(typeof chrome !== 'undefined')
document.documentElement.dataset.hasTabs = String(typeof chrome !== 'undefined' && typeof chrome.tabs !== 'undefined')
