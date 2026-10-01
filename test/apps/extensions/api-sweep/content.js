// Publishes the content script's own sweep on the page's DOM, where the test
// reads it: the isolated world and the page share the document, nothing else.
document.documentElement.dataset.orivonSweep = JSON.stringify(globalThis.__sweep())
