chrome.runtime.sendMessage({ kind: 'dnr-status' })
  .then((r) => { document.documentElement.dataset.dnrStatus = JSON.stringify(r) })
  .catch((e) => { document.documentElement.dataset.dnrStatusErr = String(e) })
