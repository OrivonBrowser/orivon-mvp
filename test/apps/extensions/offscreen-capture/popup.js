// Fixture popup for test/extensions/e2e-extensions-offscreen-capture.test.ts. Clicking
// #capture is the "allowed" half of the invocation-gate test: the toolbar
// click that opened this popup already granted the invocation
// (browser-action.ts's own activateClick), so the same chrome.tabCapture
// call that a hidden sender page's earlier, un-invoked call refused now
// succeeds.
document.title = 'Offscreen Capture Popup'

const result = document.getElementById('result')

document.getElementById('capture').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  await chrome.runtime.sendMessage({ cmd: 'ensure-offscreen' })
  const response = await chrome.runtime.sendMessage({ cmd: 'capture', tabId: tab.id })
  result.textContent = JSON.stringify(response)
})
