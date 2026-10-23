// Answers `{ cmd: 'call', path, args }` from a page of this extension: calls
// the function at `path` (`chrome.tabs.query`, or `__sweep`) in this worker
// and replies `{ ok: true, result }` or `{ ok: false, error }`. The page and
// the test never reach the worker's own globals any other way.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message === null || typeof message !== 'object' || message.cmd !== 'call') return false
  const parts = String(message.path).split('.')
  const name = parts.pop()
  let owner = globalThis
  for (const part of parts) owner = owner === undefined || owner === null ? undefined : owner[part]
  Promise.resolve()
    .then(() => owner[name](...(Array.isArray(message.args) ? message.args : [])))
    .then((result) => { sendResponse({ ok: true, result: result === undefined ? null : result }) })
    .catch((error) => { sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }) })
  return true
})
