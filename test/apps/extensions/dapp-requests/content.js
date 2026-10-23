// The page talks to this script with window.postMessage; the script forwards the request to the worker, and answers
// the worker's side-panel question only while the page has user activation (a real click or key, never a script).
window.addEventListener('message', (event) => {
  if (event.source !== window || event.data === null || typeof event.data !== 'object' || event.data.type !== 'dapp-request') return
  chrome.runtime.sendMessage({ type: 'dapp-request' })
})

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'REQUEST_OPEN_SIDEPANEL' && navigator.userActivation && navigator.userActivation.isActive) {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL', nonce: message.nonce })
  }
  return false
})
