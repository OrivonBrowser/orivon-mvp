chrome.runtime.sendMessage({ kind: 'wr-status' })
  .then((r) => { document.documentElement.dataset.wrStatus = JSON.stringify(r) })
  .catch((e) => { document.documentElement.dataset.wrStatusErr = String(e) })
