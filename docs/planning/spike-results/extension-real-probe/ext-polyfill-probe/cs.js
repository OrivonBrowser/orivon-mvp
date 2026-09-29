new Promise((r) => setTimeout(r, 500)).then(() => chrome.runtime.sendMessage({ kind: 'polyfill-status' }))
  .then((r) => { document.documentElement.dataset.polyfillStatus = JSON.stringify(r) })
  .catch((e) => { document.documentElement.dataset.polyfillStatusErr = String(e) })
